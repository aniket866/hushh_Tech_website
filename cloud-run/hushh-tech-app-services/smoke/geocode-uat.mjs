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

async function call(path, { googleToken, firebaseToken, uid, authTime, method = "GET", body, headers = {} } = {}) {
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

const serviceUrl = required("SERVICE_URL").replace(/\/$/, "");
const firebaseToken = required("FIREBASE_ID_TOKEN");
const expectedUid = required("EXPECTED_FIREBASE_UID");
const firebase = decodeJwtPayload(firebaseToken);
assert(firebase.sub === expectedUid, "Firebase UID is not exact.");
assert(firebase.aud === "hushh-tech-uat", "Firebase audience is not UAT.");
assert(
  firebase.iss === "https://securetoken.google.com/hushh-tech-uat",
  "Firebase issuer is not UAT.",
);
assert(firebase.product_client === "hushh-tech", "Firebase product client drifted.");
assert(
  firebase.product_client_app_id === "app_hushh-technologies_cd1895ef",
  "Firebase product app drifted.",
);
assert(firebase.product_audience === "hushh-tech-uat", "Firebase product audience drifted.");
assert(
  typeof firebase.product_launch_authorization_id === "string" &&
    firebase.product_launch_authorization_id.length > 0,
  "Firebase launch authorization is missing.",
);
assert(Number.isFinite(firebase.auth_time), "Firebase auth time is missing.");

const googleToken = await googleIdentityToken(serviceUrl);
const route = "/api/v1/legacy-functions/hushh-location-geocode";

const ready = await call("/readyz", { googleToken });
assert(ready.response.status === 200 && ready.json?.status === "ready", "Readiness failed.");

const platformDenied = await call(route, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
});
assert([401, 403].includes(platformDenied.response.status), "Platform unauthenticated request was not rejected.");

const firebaseDenied = await call(route, {
  googleToken,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
});
assert(
  firebaseDenied.response.status === 401 &&
    firebaseDenied.json?.detail?.code === "UNAUTHENTICATED",
  "Missing Firebase session was not rejected.",
);

const methodDenied = await call(route, {
  googleToken,
  firebaseToken,
  uid: expectedUid,
  authTime: firebase.auth_time,
});
assert(
  methodDenied.response.status === 405 &&
    methodDenied.json?.detail?.code === "METHOD_NOT_ALLOWED",
  "Wrong method was not rejected.",
);

const queryDenied = await call(`${route}?unexpected=1`, {
  googleToken,
  firebaseToken,
  uid: expectedUid,
  authTime: firebase.auth_time,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
});
assert(
  queryDenied.response.status === 400 &&
    queryDenied.json?.detail?.code === "INVALID_REQUEST",
  "Unexpected query was not rejected.",
);

const mediaDenied = await call(route, {
  googleToken,
  firebaseToken,
  uid: expectedUid,
  authTime: firebase.auth_time,
  method: "POST",
  headers: { "content-type": "text/plain" },
  body: "37.7749,-122.4194",
});
assert(
  mediaDenied.response.status === 415 &&
    mediaDenied.json?.detail?.code === "UNSUPPORTED_MEDIA_TYPE",
  "Wrong media type was not rejected.",
);

const success = await call(route, {
  googleToken,
  firebaseToken,
  uid: expectedUid,
  authTime: firebase.auth_time,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
});
assert(success.response.status === 200 && success.json?.success === true, "Geocode did not succeed.");
assert(success.json?.data?.latitude === 37.7749, "Latitude response drifted.");
assert(success.json?.data?.longitude === -122.4194, "Longitude response drifted.");
assert(typeof success.json?.data?.countryCode === "string", "Country response is incomplete.");
assert(success.response.headers.get("cache-control") === "private, no-store", "Cache contract drifted.");
assert(success.response.headers.get("access-control-allow-origin") === null, "Private route exposed CORS.");
assert(success.response.headers.get("etag") === null, "Private route exposed an ETag.");
assert(success.response.headers.get("content-type")?.startsWith("application/json"), "Media type drifted.");

const invalid = await call(route, {
  googleToken,
  firebaseToken,
  uid: expectedUid,
  authTime: firebase.auth_time,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ latitude: 91, longitude: 0 }),
});
assert(
  invalid.response.status === 400 &&
    invalid.json?.success === false &&
    invalid.json?.error === "Invalid latitude or longitude",
  "Coordinate validation drifted.",
);

const stockDefaultOff = await call("/api/v1/public/stock-quotes", {
  googleToken,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert(
  stockDefaultOff.response.status === 404 &&
    stockDefaultOff.json?.detail?.code === "INVALID_ROUTE",
  "Stock route is not default-off.",
);

console.log(
  JSON.stringify({
    status: "PASS",
    service: "hushh-tech-investor-api",
    route,
    readiness_status: ready.response.status,
    platform_unauth_status: platformDenied.response.status,
    firebase_unauth_status: firebaseDenied.response.status,
    method_status: methodDenied.response.status,
    query_status: queryDenied.response.status,
    media_status: mediaDenied.response.status,
    success_status: success.response.status,
    invalid_coordinate_status: invalid.response.status,
    stock_default_off_status: stockDefaultOff.response.status,
    firebase_project_id: firebase.aud,
    rate_limit_side_effect: "PASS_BY_HANDLER_EXECUTION",
  }),
);
