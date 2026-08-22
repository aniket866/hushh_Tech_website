import { randomBytes } from "node:crypto";
import { once } from "node:events";

import express from "express";

import { createLegacyFunctionsHandler } from "../../api/legacy-functions.js";
import {
  createLegacyFunctionRawBodyParser,
  legacyFunctionParserError,
  preserveLegacyFunctionRawBody,
} from "../../api/shared/legacyFunctionRawBody.js";

const PROJECT = "hushh-tech-uat";
const INVESTOR_ORIGIN =
  "https://hushh-tech-investor-api-175298245599.us-central1.run.app";
const IDENTITY_ORIGIN =
  "https://hushh-tech-identity-api-175298245599.us-central1.run.app";
const ENGAGEMENT_ORIGIN =
  "https://hushh-tech-engagement-api-175298245599.us-central1.run.app";
const AUTH_ROOT = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`;
const METADATA_TOKEN_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_IDENTITY_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function metadataAccessToken() {
  const response = await fetch(METADATA_TOKEN_ENDPOINT, {
    headers: { "Metadata-Flavor": "Google" },
    redirect: "error",
  });
  assert(response.ok, `Metadata access token failed with ${response.status}.`);
  const body = await response.json();
  const token = String(body.access_token ?? "");
  assert(token.length > 32, "Metadata access token is missing.");
  return token;
}

async function googleIdentityToken(audience) {
  const endpoint = new URL(METADATA_IDENTITY_ENDPOINT);
  endpoint.searchParams.set("audience", audience);
  endpoint.searchParams.set("format", "full");
  const response = await fetch(endpoint, {
    headers: { "Metadata-Flavor": "Google" },
    redirect: "error",
  });
  assert(response.ok, `Metadata identity token failed with ${response.status}.`);
  const token = (await response.text()).trim();
  assert(token.split(".").length === 3, "Google identity token is malformed.");
  return token;
}

async function jsonRequest(url, accessToken, body, label) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${label}_${response.status}`);
  return response.json();
}

async function createUser(accessToken) {
  const nonce = randomBytes(8).toString("hex");
  const email = `codex-geocode-gateway-${nonce}@example.test`;
  const password = `${randomBytes(24).toString("base64url")}A1!`;
  const created = await jsonRequest(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp",
    accessToken,
    {
      targetProjectId: PROJECT,
      email,
      password,
      emailVerified: true,
      displayName: "UAT geocode gateway proof",
      returnSecureToken: false,
    },
    "CREATE_USER",
  );
  const uid = String(created.localId ?? "");
  assert(uid, "Created Firebase user has no UID.");
  await jsonRequest(
    `${AUTH_ROOT}:update`,
    accessToken,
    {
      localId: uid,
      customAttributes: JSON.stringify({
        product_client: "hushh-tech",
        product_client_app_id: "app_hushh-technologies_cd1895ef",
        product_audience: PROJECT,
        product_launch_authorization_id: `geocode-gateway-${nonce}`,
        product_launch_valid_after_ms: Date.now() - 1_000,
      }),
    },
    "SET_CUSTOM_CLAIMS",
  );
  const signedIn = await jsonRequest(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
    accessToken,
    { email, password, returnSecureToken: true },
    "SIGN_IN_USER",
  );
  const idToken = String(signedIn.idToken ?? "");
  assert(idToken.split(".").length === 3, "Firebase ID token is missing.");
  return Object.freeze({ uid, idToken });
}

async function deleteUser(accessToken, uid) {
  if (!uid) return true;
  try {
    await jsonRequest(
      `${AUTH_ROOT}:delete`,
      accessToken,
      { localId: uid },
      "DELETE_USER",
    );
    return true;
  } catch {
    return false;
  }
}

async function parsed(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

async function directCall(origin, path, { token, firebaseToken, uid, method = "GET", body } = {}) {
  return parsed(
    await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(firebaseToken
          ? {
              "x-hushh-firebase-authorization": `Bearer ${firebaseToken}`,
              "x-hushh-firebase-uid": uid,
              "x-hushh-firebase-auth-time": String(
                JSON.parse(
                  Buffer.from(firebaseToken.split(".")[1], "base64url").toString("utf8"),
                ).auth_time,
              ),
            }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    }),
  );
}

const accessToken = await metadataAccessToken();
const inventory = await jsonRequest(
  `${AUTH_ROOT}:batchGet?maxResults=1000`,
  accessToken,
  undefined,
  "LIST_USERS",
);
assert(!inventory.nextPageToken, "Firebase user inventory is unexpectedly paginated.");
const users = Array.isArray(inventory.users) ? inventory.users : [];
const fundAdminBooleanCount = users.filter((user) => {
  try {
    return JSON.parse(user.customAttributes ?? "{}").fund_admin === true;
  } catch {
    return false;
  }
}).length;

let user;
let server;
let failure = null;
try {
  user = await createUser(accessToken);
  const app = express();
  app.use("/functions/v1", createLegacyFunctionRawBodyParser({ limit: "10mb" }));
  app.use("/functions/v1", preserveLegacyFunctionRawBody);
  app.use(legacyFunctionParserError);
  app.all(
    "/functions/v1/*",
    createLegacyFunctionsHandler({
      env: {
        GOOGLE_CLOUD_PROJECT: PROJECT,
        FIREBASE_PROJECT_ID: PROJECT,
        HUSHH_TECH_GCP_FUNCTIONS_ENABLED: "true",
        HUSHH_TECH_INVESTOR_API_URL: INVESTOR_ORIGIN,
      },
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const unauthenticated = await parsed(
    await fetch(`${origin}/functions/v1/hushh-location-geocode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
    }),
  );
  assert(
    unauthenticated.response.status === 401 &&
      unauthenticated.body?.detail?.code === "UNAUTHENTICATED",
    "Same-origin gateway did not reject a missing Firebase session.",
  );

  const success = await parsed(
    await fetch(`${origin}/functions/v1/hushh-location-geocode`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.idToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
    }),
  );
  assert(success.response.status === 200 && success.body?.success === true, "Geocode failed.");
  assert(success.body?.data?.latitude === 37.7749, "Latitude response drifted.");
  assert(success.body?.data?.longitude === -122.4194, "Longitude response drifted.");
  assert(typeof success.body?.data?.countryCode === "string", "Country code is missing.");
  assert(
    success.response.headers.get("x-hushh-compatibility-source") === "gcp",
    "Same-origin response did not prove the GCP source.",
  );
  assert(
    success.response.headers.get("cache-control") === "private, no-store",
    "Same-origin response cache contract drifted.",
  );

  const ndaFrozen = await parsed(
    await fetch(`${origin}/functions/v1/nda-admin-fetch`, { method: "POST" }),
  );
  assert(
    ndaFrozen.response.status === 503 &&
      ndaFrozen.body?.detail?.code === "FUNCTION_NOT_MIGRATED",
    "NDA gateway route is not frozen.",
  );
  const retired = await parsed(
    await fetch(`${origin}/functions/v1/get-secrets`, { method: "GET" }),
  );
  assert(
    retired.response.status === 410 && retired.body?.detail?.code === "FEATURE_RETIRED",
    "Retired gateway route drifted.",
  );

  const investorToken = await googleIdentityToken(INVESTOR_ORIGIN);
  const identityToken = await googleIdentityToken(IDENTITY_ORIGIN);
  const engagementToken = await googleIdentityToken(ENGAGEMENT_ORIGIN);
  const ready = await directCall(INVESTOR_ORIGIN, "/readyz", { token: investorToken });
  assert(ready.response.status === 200 && ready.body?.status === "ready", "Investor readiness failed.");
  const directRetired = await directCall(
    IDENTITY_ORIGIN,
    "/api/v1/legacy-functions/get-secrets",
    { token: identityToken },
  );
  assert(
    directRetired.response.status === 410 &&
      directRetired.body?.detail?.code === "FEATURE_RETIRED",
    "Direct retirement contract drifted.",
  );
  const directNdaFrozen = await directCall(
    ENGAGEMENT_ORIGIN,
    "/api/v1/legacy-functions/nda-admin-fetch",
    {
      token: engagementToken,
      firebaseToken: user.idToken,
      uid: user.uid,
      method: "POST",
      body: {},
    },
  );
  assert(
    directNdaFrozen.response.status === 503 &&
      directNdaFrozen.body?.detail?.code === "FUNCTION_NOT_MIGRATED",
    "Direct NDA route is not frozen.",
  );

  console.log(
    JSON.stringify({
      status: "PASS",
      project_id: PROJECT,
      same_origin_route: "/functions/v1/hushh-location-geocode",
      same_origin_unauthenticated_status: unauthenticated.response.status,
      same_origin_success_status: success.response.status,
      compatibility_source: success.response.headers.get("x-hushh-compatibility-source"),
      investor_readiness_status: ready.response.status,
      gateway_nda_frozen_status: ndaFrozen.response.status,
      direct_nda_frozen_status: directNdaFrozen.response.status,
      gateway_retired_status: retired.response.status,
      direct_retired_status: directRetired.response.status,
      preexisting_user_count: users.length,
      preexisting_fund_admin_boolean_count: fundAdminBooleanCount,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const userDeleted = await deleteUser(accessToken, user?.uid);
assert(userDeleted, "Synthetic Firebase user cleanup failed.");
console.log(
  JSON.stringify({
    status: "CLEANED",
    synthetic_firebase_user_retained: false,
    preexisting_user_count: users.length,
    preexisting_fund_admin_boolean_count: fundAdminBooleanCount,
  }),
);
if (failure) throw failure;
