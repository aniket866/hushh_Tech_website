import {
  buildGcpFunctionRegistry,
  createGcpFunctionGateway,
} from "./shared/gcpFunctionGateway.js";
import { GCP_FUNCTION_CONTRACTS } from "./shared/gcpFunctionContracts.js";
import { createMetadataIdentityTokenProvider } from "./shared/gcpServiceIdentity.js";
import { verifyHushhResearchFirebaseToken } from "./shared/hushhResearchFirebase.js";
import { SUPABASE_RETIREMENT_FUNCTIONS } from "./shared/supabaseRetirementFunctionRegistry.js";

const FIREBASE_PROJECT_ID = "hushh-pda";
const DEVELOPER_APP_ID = "app_hushh-technologies_cd1895ef";
const EXPECTED_AUDIENCE = Object.freeze({
  "hushh-tech-uat": "hushh-tech-uat",
  "hushh-tech-prod": "hushh-tech-prod",
});

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readGcpFunctionFirebaseConfig(env = process.env) {
  const project = clean(env.GOOGLE_CLOUD_PROJECT);
  const expectedAudience = EXPECTED_AUDIENCE[project];
  const apiKey = clean(
    env.HUSHH_TECH_FIREBASE_API_KEY ?? env.HUSHH_RESEARCH_FIREBASE_API_KEY,
  );
  const projectId = clean(
    env.HUSHH_TECH_FIREBASE_PROJECT_ID ??
      env.HUSHH_RESEARCH_FIREBASE_PROJECT_ID,
  );
  const audience = clean(
    env.HUSHH_TECH_PRODUCT_AUDIENCE ?? env.HUSHH_RESEARCH_AUDIENCE,
  );
  const developerAppId = clean(
    env.HUSHH_TECH_DEVELOPER_APP_ID ?? env.HUSHH_RESEARCH_DEVELOPER_APP_ID,
  );

  if (
    !expectedAudience ||
    !apiKey ||
    projectId !== FIREBASE_PROJECT_ID ||
    audience !== expectedAudience ||
    developerAppId !== DEVELOPER_APP_ID
  ) {
    return null;
  }

  return Object.freeze({
    firebase: Object.freeze({ apiKey, projectId }),
    audience,
    developerAppId,
  });
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
  const registry = buildGcpFunctionRegistry(SUPABASE_RETIREMENT_FUNCTIONS);
  const firebaseConfig = readGcpFunctionFirebaseConfig(env);
  const verifier =
    verifyFirebaseToken ??
    (async (token) => {
      if (!firebaseConfig) {
        const error = new Error("Firebase product authentication is unavailable.");
        error.state = "UPSTREAM_UNAVAILABLE";
        throw error;
      }
      return verifyHushhResearchFirebaseToken(token, firebaseConfig, {
        fetchImpl,
        now,
      });
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
