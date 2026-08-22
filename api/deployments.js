/**
 * /api/deployments — internal deployments dashboard data source.
 *
 * Lists Cloud Run revisions for the website service across UAT + PROD using the
 * runtime service account (ADC, same pattern as api/metrics). Each revision maps
 * to a "deployment": when it was created, whether it is currently live (serving
 * traffic), and its per-build URL (the Cloud Run revision TAG url, if tagged).
 *
 * Gated by a revoked-token-aware Firebase custom claim. The browser gate is
 * only presentation; this handler is the security boundary.
 */
import { google } from "googleapis";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const SERVICE = "hushh-tech-website";
const REGION = "us-central1";
const PROJECTS = [
  { env: "PROD", project: "hushh-tech-prod" },
  { env: "UAT", project: "hushh-tech-uat" },
];
const MAX_PER_ENV = 50;
const FIREBASE_PROJECT_ID = "hushh-tech-uat";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_APP_NAME = "hushh-tech-deployments-uat";

function statusError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function assertDeploymentAuthority(env) {
  const declaredProjects = [env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (
    declaredProjects.length === 0 ||
    declaredProjects.some((value) => value !== FIREBASE_PROJECT_ID) ||
    String(env.FIREBASE_PROJECT_ID || "").trim() !== FIREBASE_PROJECT_ID
  ) {
    throw statusError("Deployment authority is unavailable.", 503, "AUTHORITY_UNAVAILABLE");
  }
}

function defaultFirebaseVerifier(env) {
  assertDeploymentAuthority(env);
  const app =
    getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME) ||
    initializeApp({ projectId: FIREBASE_PROJECT_ID }, FIREBASE_APP_NAME);
  if (app.options.projectId !== FIREBASE_PROJECT_ID) {
    throw statusError("Deployment authority is unavailable.", 503, "AUTHORITY_UNAVAILABLE");
  }
  return (token) => getAuth(app).verifyIdToken(token, true);
}

export async function authorizeDeploymentsRequest(
  req,
  { env = process.env, verifyIdToken } = {},
) {
  assertDeploymentAuthority(env);
  const match = String(req?.headers?.authorization || "").match(/^Bearer\s+([^\s]{1,8192})$/i);
  if (!match) throw statusError("Sign in required.", 401, "AUTH_REQUIRED");
  let decoded;
  try {
    decoded = await (verifyIdToken || defaultFirebaseVerifier(env))(match[1]);
  } catch (error) {
    if (error?.code === "app/network-error" || error?.code === "auth/internal-error") {
      throw statusError("Deployment authority is unavailable.", 503, "AUTHORITY_UNAVAILABLE");
    }
    throw statusError("Authentication is invalid.", 401, "AUTH_INVALID");
  }
  if (
    !decoded?.uid ||
    decoded.sub !== decoded.uid ||
    decoded.aud !== FIREBASE_PROJECT_ID ||
    decoded.iss !== FIREBASE_ISSUER ||
    !Number.isFinite(decoded.auth_time)
  ) {
    throw statusError("Authentication is invalid.", 401, "AUTH_INVALID");
  }
  if (decoded.deployment_admin !== true) {
    throw statusError("Access denied.", 403, "ADMIN_REQUIRED");
  }
  return { uid: decoded.uid };
}

async function getAccessToken() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res && res.token;
  if (!token) throw new Error("Could not obtain Google access token");
  return token;
}

async function runApi(path, token) {
  const r = await fetch(`https://run.googleapis.com/v2/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Cloud Run API ${r.status}: ${text.slice(0, 180)}`);
  }
  return r.json();
}

async function listEnv({ env, project }, token) {
  const base = `projects/${project}/locations/${REGION}/services/${SERVICE}`;

  // Service → observed traffic (which revision is live) + tag URLs.
  const svc = await runApi(base, token);
  const statuses = Array.isArray(svc.trafficStatuses) ? svc.trafficStatuses : [];
  const liveRevisions = new Set(
    statuses.filter((s) => (s.percent || 0) > 0 && s.revision).map((s) => s.revision),
  );
  const tagUrlByRevision = {};
  for (const s of statuses) {
    if (s.revision && s.uri && s.tag) tagUrlByRevision[s.revision] = s.uri;
  }

  // Revisions → the deployment history.
  const revResp = await runApi(`${base}/revisions?pageSize=${MAX_PER_ENV}`, token);
  const revisions = Array.isArray(revResp.revisions) ? revResp.revisions : [];

  return revisions.map((rev) => {
    const short = String(rev.name || "").split("/").pop();
    return {
      env,
      revision: short,
      createdAt: rev.createTime || null,
      isLive: liveRevisions.has(short),
      buildUrl: tagUrlByRevision[short] || null,
      image: (rev.containers && rev.containers[0] && rev.containers[0].image) || null,
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    await authorizeDeploymentsRequest(req);
    const token = await getAccessToken();
    const results = await Promise.allSettled(PROJECTS.map((p) => listEnv(p, token)));
    const deployments = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") deployments.push(...r.value);
      else errors.push({ env: PROJECTS[i].env, error: String((r.reason && r.reason.message) || r.reason) });
    });
    deployments.sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
    );
    return res.status(200).json({ success: true, deployments, errors });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    return res
      .status(status)
      .json({ success: false, error: status === 500 ? "Deployments unavailable." : String(err.message) });
  }
}
