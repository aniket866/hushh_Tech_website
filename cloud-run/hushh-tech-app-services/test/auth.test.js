import assert from "node:assert/strict";
import test from "node:test";

import { createFirebaseProductVerifier } from "../src/auth/firebase.js";
import { createGoogleServiceVerifier } from "../src/auth/google.js";
import { RuntimeError } from "../src/errors.js";
import { VALID_TOKEN } from "./helpers.js";

const NOW_MS = 2_000_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);

const CONFIG = Object.freeze({
  firebaseProjectId: "hushh-tech-uat",
  productClient: "hushh-tech",
  productClientAppId: "app_hushh-technologies_cd1895ef",
  productAudience: "hushh-tech-uat",
  recentAuthSeconds: 300,
  serviceAudience:
    "https://hushh-tech-worker-175298245599.us-central1.run.app",
  allowedGoogleCallers: Object.freeze([
    "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com",
  ]),
});

function firebaseClaims(overrides = {}) {
  return {
    uid: "firebase-user-1",
    sub: "firebase-user-1",
    aud: "hushh-tech-uat",
    iss: "https://securetoken.google.com/hushh-tech-uat",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    auth_time: NOW_SECONDS - 20,
    product_client: "hushh-tech",
    product_client_app_id: "app_hushh-technologies_cd1895ef",
    product_audience: "hushh-tech-uat",
    product_launch_authorization_id: "launch-authorization-1",
    product_launch_valid_after_ms: NOW_MS - 20_000,
    ...overrides,
  };
}

function firebaseRequest(overrides = {}) {
  return {
    headers: {
      "x-hushh-firebase-authorization": `Bearer ${VALID_TOKEN}`,
      "x-hushh-firebase-uid": "firebase-user-1",
      "x-hushh-firebase-auth-time": String(NOW_SECONDS - 20),
      ...overrides,
    },
  };
}

function assertRuntimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

test("Firebase user route reverifies revocation and exact product claims", async () => {
  const calls = [];
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      calls.push({ token, checkRevoked });
      return firebaseClaims();
    },
  };
  const verify = createFirebaseProductVerifier({
    config: CONFIG,
    auth,
    now: () => NOW_MS,
  });
  const actor = await verify(firebaseRequest(), { auth_mode: "firebase_bearer" });
  assert.deepEqual(calls, [{ token: VALID_TOKEN, checkRevoked: true }]);
  assert.deepEqual(actor, {
    kind: "firebase",
    uid: "firebase-user-1",
    authTime: NOW_SECONDS - 20,
    launchAuthorizationId: "launch-authorization-1",
    fundAdmin: false,
  });
});

test("Firebase fund admin context accepts only the literal boolean custom claim", async () => {
  for (const [claim, expected] of [
    [true, true],
    [false, false],
    ["true", false],
    [1, false],
    [undefined, false],
  ]) {
    const decoded = firebaseClaims(
      claim === undefined ? {} : { fund_admin: claim },
    );
    const verify = createFirebaseProductVerifier({
      config: CONFIG,
      auth: { verifyIdToken: async () => decoded },
      now: () => NOW_MS,
    });
    const actor = await verify(firebaseRequest(), {
      auth_mode: "firebase_bearer",
    });
    assert.equal(actor.fundAdmin, expected);
  }
});

test("Firebase user route rejects altered, stale, or mismatched evidence", async () => {
  const claimChanges = [
    { aud: "other" },
    { iss: "https://securetoken.google.com/other" },
    { exp: NOW_SECONDS },
    { iat: NOW_SECONDS + 301 },
    { sub: "other-user" },
    { product_client: "other-product" },
    { product_client_app_id: "other-app" },
    { product_audience: "hushh-tech-prod" },
    { product_launch_authorization_id: "" },
    { product_launch_valid_after_ms: NOW_MS + 1 },
    { product_launch_valid_after_ms: NOW_MS - 1_000 },
  ];
  for (const change of claimChanges) {
    const verify = createFirebaseProductVerifier({
      config: CONFIG,
      auth: { verifyIdToken: async () => firebaseClaims(change) },
      now: () => NOW_MS,
    });
    await assert.rejects(
      verify(firebaseRequest(), { auth_mode: "firebase_bearer" }),
      (error) => assertRuntimeCode(error, "UNAUTHENTICATED", 401),
    );
  }

  const verify = createFirebaseProductVerifier({
    config: CONFIG,
    auth: { verifyIdToken: async () => firebaseClaims() },
    now: () => NOW_MS,
  });
  await assert.rejects(
    verify(firebaseRequest({ "x-hushh-firebase-uid": "other-user" }), {
      auth_mode: "firebase_bearer",
    }),
    (error) => assertRuntimeCode(error, "UNAUTHENTICATED", 401),
  );
  await assert.doesNotReject(
    verify(firebaseRequest(), { auth_mode: "firebase_bearer_recent_auth" }),
  );
});

test("Firebase recent-auth and revoked-token failures stay fail closed", async () => {
  const stale = createFirebaseProductVerifier({
    config: CONFIG,
    auth: {
      verifyIdToken: async () =>
        firebaseClaims({ auth_time: NOW_SECONDS - 301 }),
    },
    now: () => NOW_MS,
  });
  await assert.rejects(
    stale(
      firebaseRequest({
        "x-hushh-firebase-auth-time": String(NOW_SECONDS - 301),
      }),
      { auth_mode: "firebase_bearer_recent_auth" },
    ),
    (error) => assertRuntimeCode(error, "RECENT_AUTH_REQUIRED", 401),
  );

  const revoked = createFirebaseProductVerifier({
    config: CONFIG,
    auth: {
      verifyIdToken: async () => {
        const error = new Error("revoked");
        error.code = "auth/id-token-revoked";
        throw error;
      },
    },
    now: () => NOW_MS,
  });
  await assert.rejects(
    revoked(firebaseRequest(), { auth_mode: "firebase_bearer" }),
    (error) => assertRuntimeCode(error, "UNAUTHENTICATED", 401),
  );
});

function googlePayload(overrides = {}) {
  return {
    aud: CONFIG.serviceAudience,
    iss: "https://accounts.google.com",
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 10,
    sub: "google-service-subject",
    email:
      "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com",
    email_verified: true,
    ...overrides,
  };
}

test("private worker ingress reverifies direct Google OIDC identity", async () => {
  const calls = [];
  const client = {
    async verifyIdToken(options) {
      calls.push(options);
      return { getPayload: () => googlePayload() };
    },
  };
  const verify = createGoogleServiceVerifier({
    config: CONFIG,
    client,
    now: () => NOW_MS,
  });
  const actor = await verify({
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
  assert.deepEqual(calls, [
    { idToken: VALID_TOKEN, audience: CONFIG.serviceAudience },
  ]);
  assert.deepEqual(actor, {
    kind: "google-service",
    email:
      "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com",
    subject: "google-service-subject",
  });
});

test("Google OIDC ingress rejects wrong caller, audience, issuer, or lifetime", async () => {
  const changes = [
    { aud: "https://wrong-example-uc.a.run.app" },
    { iss: "https://issuer.invalid" },
    { exp: NOW_SECONDS },
    { iat: NOW_SECONDS + 301 },
    { sub: "" },
    { email: "other@hushh-tech-uat.iam.gserviceaccount.com" },
    { email_verified: false },
  ];
  for (const change of changes) {
    const verify = createGoogleServiceVerifier({
      config: CONFIG,
      client: {
        verifyIdToken: async () => ({ getPayload: () => googlePayload(change) }),
      },
      now: () => NOW_MS,
    });
    await assert.rejects(
      verify({ headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
      (error) =>
        assertRuntimeCode(error, "INTERNAL_CALLER_UNAUTHENTICATED", 401),
    );
  }
});
