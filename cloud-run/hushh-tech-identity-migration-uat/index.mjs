import { createHash } from "node:crypto";

const TARGET_PROJECT = "hushh-tech-uat";
const PROD_PROJECT = "hushh-pda";
const METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") throw new Error("ARTIFACT_INVALID");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

async function accessToken() {
  const response = await fetch(METADATA_TOKEN, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("METADATA_TOKEN_FAILED");
  const payload = await response.json();
  if (typeof payload.access_token !== "string") throw new Error("METADATA_TOKEN_FAILED");
  return payload.access_token;
}

async function listUsers(token, project, maxResults = 1000) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchGet?maxResults=${maxResults}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  return { status: response.status, users: payload.users ?? [], nextPageToken: payload.nextPageToken ?? null };
}

async function testProductionPermission(token) {
  const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROD_PROJECT}:testIamPermissions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ permissions: ["firebaseauth.users.get", "firebaseauth.users.create"] }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  return { status: response.status, permissions: payload.permissions ?? [] };
}

async function downloadArtifact(token) {
  const bucket = process.env.ARTIFACT_BUCKET;
  const object = process.env.ARTIFACT_OBJECT;
  const generation = process.env.ARTIFACT_GENERATION;
  if (bucket !== "hushh-tech-migration-evidence-uat" || !/^identity\/uat\/[a-f0-9]{64}\.json$/.test(object ?? "") || !/^[1-9][0-9]{0,19}$/.test(generation ?? "")) {
    throw new Error("ARTIFACT_BINDING_INVALID");
  }
  const encoded = encodeURIComponent(object);
  const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded}?alt=media&generation=${generation}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("ARTIFACT_DOWNLOAD_FAILED");
  const artifact = await response.json();
  const { artifactSha256, ...payload } = artifact;
  if (
    artifactSha256 !== process.env.ARTIFACT_SHA256 ||
    hash(payload) !== artifactSha256 ||
    artifact.kind !== "HUSHH_TECH_UAT_TRANSIENT_IDENTITY_MAPPING" ||
    artifact.firebaseAuthority?.projectId !== TARGET_PROJECT ||
    artifact.counts?.authTerminalCount !== 369 ||
    artifact.counts?.unclaimedLegacyPrincipals !== 0 ||
    !Array.isArray(artifact.importUsers)
  ) throw new Error("ARTIFACT_INVALID");
  return artifact;
}

async function importUsers(token, artifact) {
  let imported = 0;
  for (let offset = 0; offset < artifact.importUsers.length; offset += 500) {
    const users = artifact.importUsers.slice(offset, offset + 500);
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${TARGET_PROJECT}/accounts:batchCreate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hashAlgorithm: "BCRYPT", users, sanityCheck: true, allowOverwrite: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json();
    if (!response.ok || (payload.error?.length ?? 0) !== 0) throw new Error("FIREBASE_IMPORT_FAILED");
    imported += users.length;
  }
  return imported;
}

async function main() {
  if (process.env.GOOGLE_CLOUD_PROJECT !== TARGET_PROJECT && process.env.GCLOUD_PROJECT !== TARGET_PROJECT) {
    throw new Error("PROJECT_BOUNDARY_INVALID");
  }
  const mode = process.env.EXECUTION_MODE ?? "PROBE";
  const token = await accessToken();
  const before = await listUsers(token, TARGET_PROJECT);
  const productionProbe = await testProductionPermission(token);
  if (before.status !== 200) throw new Error(`UAT_GET_HTTP_${before.status}`);
  if (productionProbe.status !== 200 || productionProbe.permissions.length !== 0) throw new Error("PROD_SCOPE_LEAK");
  if (mode === "PROBE") {
    process.stdout.write(`${JSON.stringify({ status: "CAPTURED", mode, targetProject: TARGET_PROJECT, uatUserCount: before.users.length, uatHasNextPage: before.nextPageToken !== null, productionAccessDenied: true })}\n`);
    return;
  }
  if (mode !== "IMPORT") throw new Error("MODE_INVALID");
  const artifact = await downloadArtifact(token);
  if (before.users.length !== artifact.counts.linkedExistingFirebase) throw new Error("FIREBASE_PRECONDITION_DRIFT");
  const imported = await importUsers(token, artifact);
  const after = await listUsers(token, TARGET_PROJECT);
  const expected = new Set(artifact.identityRows.map(({ firebaseUid }) => firebaseUid));
  const actual = new Set(after.users.map(({ localId }) => localId));
  if (after.nextPageToken !== null || expected.size !== 369 || [...expected].some((uid) => !actual.has(uid))) throw new Error("FIREBASE_IMPORT_PARITY_MISMATCH");
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", mode, targetProject: TARGET_PROJECT, imported, linkedExisting: artifact.counts.linkedExistingFirebase, finalUserCount: after.users.length, uidParitySha256: hash([...expected].sort()), productionAccessDenied: true, artifactSha256: artifact.artifactSha256 })}\n`);
}

main().catch((error) => {
  const blocker = /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "IDENTITY_JOB_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker })}\n`);
  process.exitCode = 1;
});
