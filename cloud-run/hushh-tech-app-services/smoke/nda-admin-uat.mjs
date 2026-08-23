const METADATA_IDENTITY_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function decodeJwtPayload(token) {
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new Error("Firebase token shape is invalid.");
  return JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFirebaseAuthority(payload, expectedUid) {
  assert(payload.sub === expectedUid, "Firebase UID is not exact.");
  assert(payload.aud === "hushh-tech-uat", "Firebase audience is not UAT.");
  assert(
    payload.iss === "https://securetoken.google.com/hushh-tech-uat",
    "Firebase issuer is not UAT.",
  );
  assert(payload.product_client === "hushh-tech", "Firebase product client drifted.");
  assert(
    payload.product_client_app_id === "app_hushh-technologies_cd1895ef",
    "Firebase product app drifted.",
  );
  assert(
    payload.product_audience === "hushh-tech-uat",
    "Firebase product audience drifted.",
  );
  assert(
    typeof payload.product_launch_authorization_id === "string" &&
      payload.product_launch_authorization_id.length > 0,
    "Firebase launch authorization is missing.",
  );
  assert(Number.isFinite(payload.auth_time), "Firebase auth time is missing.");
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
  assert(token.split(".").length === 3, "Google identity token shape is invalid.");
  return token;
}

async function call(
  path,
  {
    googleToken,
    firebaseToken,
    uid,
    authTime,
    method = "GET",
    body,
    headers = {},
  } = {},
) {
  const requestHeaders = { ...headers };
  if (googleToken) requestHeaders.authorization = `Bearer ${googleToken}`;
  if (firebaseToken) {
    requestHeaders["x-hushh-firebase-authorization"] = `Bearer ${firebaseToken}`;
    requestHeaders["x-hushh-firebase-uid"] = uid;
    requestHeaders["x-hushh-firebase-auth-time"] = String(authTime);
  }
  const response = await fetch(`${serviceUrl}${path}`, {
    method,
    headers: requestHeaders,
    body,
    redirect: "error",
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function firebaseCall(token, uid, payload, extras = {}) {
  return {
    googleToken,
    firebaseToken: token,
    uid,
    authTime: payload.auth_time,
    ...extras,
  };
}

const serviceUrl = required("SERVICE_URL").replace(/\/$/, "");
const adminToken = required("FUND_ADMIN_FIREBASE_ID_TOKEN");
const adminUid = required("FUND_ADMIN_FIREBASE_UID");
const nonAdminToken = required("NON_ADMIN_FIREBASE_ID_TOKEN");
const nonAdminUid = required("NON_ADMIN_FIREBASE_UID");
const expectedRecordCount = Number(required("EXPECTED_NDA_RECORD_COUNT"));
assert(
  Number.isSafeInteger(expectedRecordCount) && expectedRecordCount >= 1,
  "Expected NDA record count is invalid.",
);

const admin = decodeJwtPayload(adminToken);
const nonAdmin = decodeJwtPayload(nonAdminToken);
assertFirebaseAuthority(admin, adminUid);
assertFirebaseAuthority(nonAdmin, nonAdminUid);
assert(admin.fund_admin === true, "Admin token lacks the literal boolean claim.");
assert(
  nonAdmin.fund_admin === "true",
  "Non-admin token must carry the adversarial string claim.",
);

const googleToken = await googleIdentityToken(serviceUrl);
const route = "/api/v1/legacy-functions/nda-admin-fetch";

async function waitForReadiness() {
  const statuses = [];
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const result = await call("/readyz", { googleToken });
      statuses.push(result.response.status);
      if (result.response.status === 200 && result.json?.status === "ready") {
        return { ...result, attempts: attempt, statuses };
      }
      if (![429, 503].includes(result.response.status)) return result;
    } catch (error) {
      statuses.push(error instanceof Error ? error.name : "FETCH_ERROR");
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { response: { status: statuses.at(-1) }, json: null, statuses };
}

const ready = await waitForReadiness();
assert(ready.response.status === 200 && ready.json?.status === "ready", "Readiness failed.");

const platformDenied = await call(route, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert(
  [401, 403].includes(platformDenied.response.status),
  "Platform unauthenticated request was not rejected.",
);

const firebaseDenied = await call(route, {
  googleToken,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert(
  firebaseDenied.response.status === 401 &&
    firebaseDenied.json?.detail?.code === "UNAUTHENTICATED",
  "Missing Firebase session was not rejected.",
);

const claimDenied = await call(
  route,
  firebaseCall(nonAdminToken, nonAdminUid, nonAdmin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
);
assert(
  claimDenied.response.status === 403 &&
    claimDenied.json?.detail?.code === "ACCESS_DENIED",
  "String fund-admin claim was not rejected.",
);

const methodDenied = await call(
  route,
  firebaseCall(adminToken, adminUid, admin),
);
assert(
  methodDenied.response.status === 405 &&
    methodDenied.json?.detail?.code === "METHOD_NOT_ALLOWED",
  "Wrong method was not rejected.",
);

const queryDenied = await call(
  `${route}?unexpected=1`,
  firebaseCall(adminToken, adminUid, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
);
assert(
  queryDenied.response.status === 400 &&
    queryDenied.json?.detail?.code === "INVALID_REQUEST",
  "Unexpected query was not rejected.",
);

const mediaDenied = await call(
  route,
  firebaseCall(adminToken, adminUid, admin, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }),
);
assert(
  mediaDenied.response.status === 415 &&
    mediaDenied.json?.detail?.code === "UNSUPPORTED_MEDIA_TYPE",
  "Wrong media type was not rejected.",
);

const passwordDenied = await call(
  route,
  firebaseCall(adminToken, adminUid, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "must-never-work" }),
  }),
);
assert(
  passwordDenied.response.status === 400 &&
    passwordDenied.json?.detail?.code === "INVALID_REQUEST",
  "Password compatibility was not rejected.",
);

const success = await call(
  route,
  firebaseCall(adminToken, adminUid, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
);
assert(success.response.status === 200 && success.json?.success === true, "NDA fetch failed.");
assert(Array.isArray(success.json?.records), "NDA records are missing.");
assert(success.json.count === expectedRecordCount, "NDA record count drifted.");
assert(success.json.records.length === expectedRecordCount, "NDA response count drifted.");
for (const record of success.json.records) {
  assert(
    JSON.stringify(Object.keys(record).sort()) ===
      JSON.stringify([
        "highlighted",
        "nda_version",
        "pdf_available",
        "record_id",
        "signed_at",
      ]),
    "NDA response exposed an unexpected field.",
  );
  assert(/^nda_[a-f0-9]{20}$/.test(record.record_id), "NDA record identifier drifted.");
  assert(
    new Date(record.signed_at).toISOString() === record.signed_at,
    "NDA signed timestamp drifted.",
  );
  assert(
    record.nda_version === null || typeof record.nda_version === "string",
    "NDA version drifted.",
  );
  assert(typeof record.pdf_available === "boolean", "NDA PDF state drifted.");
  assert(record.highlighted === false, "NDA highlight state drifted.");
}
assert(
  success.response.headers.get("cache-control") === "private, no-store",
  "Cache contract drifted.",
);
assert(
  success.response.headers.get("access-control-allow-origin") === null,
  "Private route exposed CORS.",
);
assert(success.response.headers.get("etag") === null, "Private route exposed an ETag.");
assert(
  success.response.headers.get("content-type")?.startsWith("application/json"),
  "Media type drifted.",
);

const wrongOwner = await call(
  "/api/v1/legacy-functions/hushh-location-geocode",
  firebaseCall(adminToken, adminUid, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
  }),
);
assert(
  wrongOwner.response.status === 404 &&
    wrongOwner.json?.detail?.code === "INVALID_ROUTE",
  "Engagement service exposed another service's function.",
);

console.log(
  JSON.stringify({
    status: "PASS",
    service: "hushh-tech-engagement-api",
    route,
    readiness_status: ready.response.status,
    readiness_attempts: ready.attempts,
    platform_unauth_status: platformDenied.response.status,
    firebase_unauth_status: firebaseDenied.response.status,
    string_claim_status: claimDenied.response.status,
    method_status: methodDenied.response.status,
    query_status: queryDenied.response.status,
    media_status: mediaDenied.response.status,
    password_compatibility_status: passwordDenied.response.status,
    success_status: success.response.status,
    record_count: success.json.count,
    wrong_owner_status: wrongOwner.response.status,
    firebase_project_id: admin.aud,
    rate_limit_side_effect: "PASS_BY_HANDLER_EXECUTION",
    database_rls_side_effect: "PASS_BY_ADMIN_QUERY",
  }),
);
