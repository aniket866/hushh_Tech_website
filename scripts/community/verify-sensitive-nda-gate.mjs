#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const TARGET = option("target", "uat").trim().toLowerCase();
const EXPECTED_MIN = Number.parseInt(option("expected-min", "1"), 10);
const BASE_URL = option("base-url", TARGET === "prod" ? "https://hushhtech.com" : "https://uat.hushhtech.com").replace(/\/+$/, "");
const SECRET_PROJECT = option("secret-project", TARGET === "prod" ? "hushh-tech-prod" : "hushh-tech-uat");
const KNOWN_NDA_SLUG = option("known-slug", "funds/fund-performance");
// Mirrors GCP_DATA_RUNTIME_ENABLED on the deployed revision. The signed half of
// this gate reads nda_signatures through the GCP data runtime, so it cannot pass
// while that runtime is off: verifyFirebaseBearer takes `config = runtimeConfig()`
// as a default parameter, runtimeConfig() throws GCP_DATA_DISABLED, and the
// caller reports the failure as a 401. The unsigned half still runs, and it is
// the half that carries the security property — with the runtime off, NDA
// content is served to nobody, which is fail-closed.
const EXPECT_DATA_RUNTIME = option("expect-data-runtime", "true").trim().toLowerCase() === "true";
const API_KEY_SECRET = option("api-key-secret", "hushh-tech-firebase-web-api-key");

if (!Number.isInteger(EXPECTED_MIN) || EXPECTED_MIN < 1) throw new Error("--expected-min must be a positive integer.");
if (!new Set(["uat", "prod"]).has(TARGET)) throw new Error(`Unsupported target ${TARGET}.`);
if (TARGET === "prod" && !flag("allow-prod")) throw new Error("Production verification requires --allow-prod.");
// Production must never skip the signed half.
if (TARGET === "prod" && !EXPECT_DATA_RUNTIME) throw new Error("Production verification cannot skip the signed NDA assertions.");

const secret = (name) => process.env[name] || execFileSync(
  "gcloud",
  ["secrets", "versions", "access", "latest", `--project=${SECRET_PROJECT}`, `--secret=${name}`],
  { encoding: "utf8" },
).trim();

async function requestJson(path, init = {}) {
  const response = await fetch(new URL(path, `${BASE_URL}/`), {
    ...init,
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, json, text };
}

async function signIn() {
  // Reuse the web API key the deploy job already reads rather than keeping a
  // second copy of the same credential under a different name.
  const apiKey = secret(API_KEY_SECRET);
  const email = secret("NDA_GATE_TEST_EMAIL");
  const password = secret("NDA_GATE_TEST_PASSWORD");
  const endpoint = new URL("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword");
  endpoint.searchParams.set("key", apiKey);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.idToken || !payload?.localId) throw new Error("Firebase NDA test identity could not sign in.");
  return { idToken: payload.idToken, uid: payload.localId };
}

const assertStatus = (label, result, expected) => {
  if (result.response.status !== expected) throw new Error(`${label}: HTTP ${result.response.status}, expected ${expected}.`);
};

const startedAt = new Date().toISOString();
const publicList = await requestJson("/api/community/posts?accessLevel=public");
assertStatus("public list", publicList, 200);

const unsignedList = await requestJson("/api/community/posts?accessLevel=nda");
if (![401, 403].includes(unsignedList.response.status)) throw new Error(`unsigned NDA list was not denied: HTTP ${unsignedList.response.status}.`);
const unsignedDetail = await requestJson(`/api/community/posts/${KNOWN_NDA_SLUG}?accessLevel=nda`);
if (![401, 403].includes(unsignedDetail.response.status)) throw new Error(`unsigned NDA detail was not denied: HTTP ${unsignedDetail.response.status}.`);

const evidence = {
  target: TARGET,
  baseUrl: BASE_URL,
  startedAt,
  dataRuntimeExpected: EXPECT_DATA_RUNTIME,
  publicStatus: publicList.response.status,
  unsignedListStatus: unsignedList.response.status,
  unsignedDetailStatus: unsignedDetail.response.status,
};

if (!EXPECT_DATA_RUNTIME) {
  // The signed half is unreachable by construction, not by regression. Record
  // exactly what was proven so the skip cannot be mistaken for a pass.
  console.log(JSON.stringify({
    ok: true,
    signedAssertionsSkipped: true,
    skipReason:
      "GCP_DATA_RUNTIME_ENABLED is false on the deployed revision, so nda_signatures cannot be read and no signed session can be established. Unsigned denial was still asserted; NDA content is served to nobody.",
    ...evidence,
    finishedAt: new Date().toISOString(),
  }, null, 2));
  process.exit(0);
}

const identity = await signIn();
const headers = { Authorization: `Bearer ${identity.idToken}` };
const signedList = await requestJson("/api/community/posts?accessLevel=nda", { headers });
assertStatus("signed NDA list", signedList, 200);
const posts = Array.isArray(signedList.json?.posts) ? signedList.json.posts : Array.isArray(signedList.json) ? signedList.json : [];
if (posts.length < EXPECTED_MIN) throw new Error(`signed NDA list returned ${posts.length}, expected at least ${EXPECTED_MIN}.`);
const selected = posts.find((post) => post?.slug === KNOWN_NDA_SLUG) || posts[0];
if (!selected?.slug) throw new Error("signed NDA list did not return a usable post.");
const signedDetail = await requestJson(`/api/community/posts/${selected.slug}?accessLevel=nda`, { headers });
assertStatus("signed NDA detail", signedDetail, 200);

console.log(JSON.stringify({
  ok: true,
  signedAssertionsSkipped: false,
  ...evidence,
  finishedAt: new Date().toISOString(),
  firebaseUidHash: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.uid)).then((value) => Buffer.from(value).toString("hex")),
  signedListStatus: signedList.response.status,
  signedDetailStatus: signedDetail.response.status,
  signedPostCount: posts.length,
}, null, 2));
