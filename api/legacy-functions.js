import {
  buildGcpFunctionRegistry,
  createGcpFunctionGateway,
} from "./shared/gcpFunctionGateway.js";
import { GCP_FUNCTION_CONTRACTS } from "./shared/gcpFunctionContracts.js";
import { createMetadataIdentityTokenProvider } from "./shared/gcpServiceIdentity.js";
import { GCP_BACKEND_RETIREMENT_FUNCTIONS } from "./shared/supabaseRetirementFunctionRegistry.js";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const FIREBASE_PROJECT_ID = "hushh-tech-uat";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_APP_NAME = "hushh-tech-legacy-functions-uat";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readGcpFunctionFirebaseConfig(env = process.env) {
  const project = clean(env.GOOGLE_CLOUD_PROJECT);
  const projectId = clean(env.FIREBASE_PROJECT_ID);
  if (project !== FIREBASE_PROJECT_ID || projectId !== FIREBASE_PROJECT_ID) {
    return null;
  }

  return Object.freeze({
    firebase: Object.freeze({ projectId }),
    audience: FIREBASE_PROJECT_ID,
    issuer: FIREBASE_ISSUER,
  });
}

export async function verifyGcpFunctionFirebaseToken(idToken, config) {
  if (
    config?.firebase?.projectId !== FIREBASE_PROJECT_ID ||
    config?.audience !== FIREBASE_PROJECT_ID ||
    config?.issuer !== FIREBASE_ISSUER
  ) {
    const error = new Error("Firebase authority is unavailable.");
    error.state = "UPSTREAM_UNAVAILABLE";
    throw error;
  }
  const app =
    getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME) ||
    initializeApp({ projectId: FIREBASE_PROJECT_ID }, FIREBASE_APP_NAME);
  let decoded;
  try {
    decoded = await getAuth(app).verifyIdToken(idToken, true);
  } catch (cause) {
    if (cause?.code === "app/network-error" || cause?.code === "auth/internal-error") {
      const error = new Error("Firebase authority is unavailable.");
      error.state = "UPSTREAM_UNAVAILABLE";
      throw error;
    }
    throw cause;
  }
  if (
    !decoded.uid ||
    decoded.sub !== decoded.uid ||
    decoded.aud !== FIREBASE_PROJECT_ID ||
    decoded.iss !== FIREBASE_ISSUER ||
    !Number.isFinite(decoded.auth_time)
  ) {
    throw new Error("Firebase token authority is invalid.");
  }
  return { uid: decoded.uid, authTime: decoded.auth_time, idToken };
}

export function createLegacyFunctionsHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestId,
  contracts = GCP_FUNCTION_CONTRACTS,
  verifyFirebaseToken,
  getServiceIdentityToken,
} = {}) {
  const registry = buildGcpFunctionRegistry(GCP_BACKEND_RETIREMENT_FUNCTIONS);
  const firebaseConfig = readGcpFunctionFirebaseConfig(env);
  const verifier =
    verifyFirebaseToken ??
    (async (token) => {
      if (!firebaseConfig) {
        const error = new Error("Firebase product authentication is unavailable.");
        error.state = "UPSTREAM_UNAVAILABLE";
        throw error;
      }
      return verifyGcpFunctionFirebaseToken(token, firebaseConfig);
    });
  const identityTokenProvider =
    getServiceIdentityToken ??
    createMetadataIdentityTokenProvider({ fetchImpl, now });

  return createGcpFunctionGateway({
    registry,
    contracts,
    env,
    fetchImpl,
    verifyFirebaseToken: verifier,
    getServiceIdentityToken: identityTokenProvider,
    now,
    requestId,
  });
}

const handler = createLegacyFunctionsHandler();

export default handler;
