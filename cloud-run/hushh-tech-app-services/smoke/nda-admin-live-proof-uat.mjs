import { randomBytes } from "node:crypto";

const PROJECT = "hushh-tech-uat";
const AUTH_ROOT = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`;
const METADATA_TOKEN_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

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

function customClaims(fundAdmin, launchId) {
  return {
    product_client: "hushh-tech",
    product_client_app_id: "app_hushh-technologies_cd1895ef",
    product_audience: "hushh-tech-uat",
    product_launch_authorization_id: launchId,
    product_launch_valid_after_ms: Date.now() - 1_000,
    fund_admin: fundAdmin,
  };
}

async function createUser(accessToken, label, fundAdmin) {
  const nonce = randomBytes(8).toString("hex");
  const email = `codex-nda-${label}-${nonce}@example.test`;
  const password = `${randomBytes(24).toString("base64url")}A1!`;
  const created = await jsonRequest(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp",
    accessToken,
    {
      targetProjectId: PROJECT,
      email,
      password,
      emailVerified: true,
      displayName: "UAT NDA contract proof",
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
      customAttributes: JSON.stringify(
        customClaims(fundAdmin, `nda-uat-${label}-${nonce}`),
      ),
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

const accessToken = await metadataAccessToken();
const existing = await jsonRequest(
  `${AUTH_ROOT}:batchGet?maxResults=1000`,
  accessToken,
  undefined,
  "LIST_USERS",
);
const users = Array.isArray(existing.users) ? existing.users : [];
assert(!existing.nextPageToken, "Firebase user inventory is unexpectedly paginated.");
const claims = users.map((user) => {
  try {
    return JSON.parse(user.customAttributes ?? "{}");
  } catch {
    return {};
  }
});
const preexistingFundAdminBooleanCount = claims.filter(
  (entry) => entry.fund_admin === true,
).length;
const preexistingFundAdminStringCount = claims.filter(
  (entry) => entry.fund_admin === "true",
).length;

let admin;
let nonAdmin;
let smokeFailure = null;
try {
  admin = await createUser(accessToken, "admin", true);
  nonAdmin = await createUser(accessToken, "nonadmin", "true");
  process.env.FUND_ADMIN_FIREBASE_ID_TOKEN = admin.idToken;
  process.env.FUND_ADMIN_FIREBASE_UID = admin.uid;
  process.env.NON_ADMIN_FIREBASE_ID_TOKEN = nonAdmin.idToken;
  process.env.NON_ADMIN_FIREBASE_UID = nonAdmin.uid;
  await import("./nda-admin-uat.mjs");
} catch (error) {
  smokeFailure = error;
} finally {
  delete process.env.FUND_ADMIN_FIREBASE_ID_TOKEN;
  delete process.env.FUND_ADMIN_FIREBASE_UID;
  delete process.env.NON_ADMIN_FIREBASE_ID_TOKEN;
  delete process.env.NON_ADMIN_FIREBASE_UID;
}

const [adminDeleted, nonAdminDeleted] = await Promise.all([
  deleteUser(accessToken, admin?.uid),
  deleteUser(accessToken, nonAdmin?.uid),
]);
assert(adminDeleted && nonAdminDeleted, "Synthetic Firebase user cleanup failed.");
console.log(
  JSON.stringify({
    status: "CLEANED",
    preexisting_user_count: users.length,
    preexisting_fund_admin_boolean_count: preexistingFundAdminBooleanCount,
    preexisting_fund_admin_string_count: preexistingFundAdminStringCount,
    synthetic_admin_retained: false,
    synthetic_non_admin_retained: false,
  }),
);
if (smokeFailure) throw smokeFailure;
