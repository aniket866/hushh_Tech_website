import { SYNTHETIC_UIDS } from "../fixtures/hushhResearchSyntheticFixtures.js";

const UAT_CONTRACT = Object.freeze({
  apiBaseUrl: "https://api.uat.hushh.ai",
  webBaseUrl: "https://uat.one.hushh.ai",
  audience: "hushh-tech-uat",
  redirectUri: "https://uat.hushhtech.com/auth/hushh-research/callback",
  firebaseProjectId: "hushh-pda-uat",
  firebaseAuthDomain: "hushh-pda-uat.firebaseapp.com",
  developerAppId: "app_hushh-technologies_cd1895ef",
  connectorKeyId: "hushh-tech-uat-x25519-1",
  launchPath: "/products/hushh-tech/launch",
  startPath: "/api/hushh-research/launch/start",
});

function clean(env, name) {
  return String(env[name] ?? "").trim();
}

function parseAllowlist(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isExactSyntheticAllowlist(allowlistedUids) {
  return (
    allowlistedUids.size === SYNTHETIC_UIDS.length &&
    SYNTHETIC_UIDS.every((uid) => allowlistedUids.has(uid))
  );
}

export function readHushhResearchConfig(env = process.env) {
  const firebase = {
    apiKey: clean(env, "HUSHH_RESEARCH_FIREBASE_API_KEY"),
    authDomain: clean(env, "HUSHH_RESEARCH_FIREBASE_AUTH_DOMAIN"),
    projectId: clean(env, "HUSHH_RESEARCH_FIREBASE_PROJECT_ID"),
    appId: clean(env, "HUSHH_RESEARCH_FIREBASE_APP_ID"),
  };
  const allowlistedUids = parseAllowlist(
    env.HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST,
  );
  const apiBaseUrl = clean(env, "HUSHH_RESEARCH_API_BASE_URL").replace(/\/$/, "");
  const webBaseUrl = clean(env, "HUSHH_RESEARCH_WEB_BASE_URL").replace(/\/$/, "");
  const audience = clean(env, "HUSHH_RESEARCH_AUDIENCE");
  const redirectUri = clean(env, "HUSHH_RESEARCH_REDIRECT_URI");
  const developerAppId = clean(env, "HUSHH_RESEARCH_DEVELOPER_APP_ID");

  // This client is deliberately impossible to enable in a production Node
  // runtime or against a non-UAT Research/Firebase target.
  const enabled =
    clean(env, "HUSHH_RESEARCH_CLIENT_ENABLED").toLowerCase() === "true" &&
    clean(env, "NODE_ENV").toLowerCase() !== "production" &&
    clean(env, "GOOGLE_CLOUD_PROJECT") === "hushh-tech-uat" &&
    apiBaseUrl === UAT_CONTRACT.apiBaseUrl &&
    webBaseUrl === UAT_CONTRACT.webBaseUrl &&
    audience === UAT_CONTRACT.audience &&
    redirectUri === UAT_CONTRACT.redirectUri &&
    firebase.projectId === UAT_CONTRACT.firebaseProjectId &&
    firebase.authDomain === UAT_CONTRACT.firebaseAuthDomain &&
    developerAppId === UAT_CONTRACT.developerAppId &&
    Object.values(firebase).every(Boolean) &&
    isExactSyntheticAllowlist(allowlistedUids);

  return Object.freeze({
    enabled,
    apiBaseUrl,
    webBaseUrl,
    audience,
    redirectUri,
    firebase: Object.freeze(firebase),
    allowlistedUids: SYNTHETIC_UIDS,
    developerAppId,
    connectorKeyId: UAT_CONTRACT.connectorKeyId,
    launchPath: UAT_CONTRACT.launchPath,
    startPath: UAT_CONTRACT.startPath,
  });
}

export function readHushhResearchServerConfig(env = process.env) {
  const config = readHushhResearchConfig(env);
  if (!config.enabled) return null;

  const developerToken = clean(env, "HUSHH_RESEARCH_DEVELOPER_TOKEN");
  const connectorPrivateKey = clean(
    env,
    "HUSHH_RESEARCH_CONNECTOR_PRIVATE_KEY",
  );
  if (developerToken.length < 32 || !connectorPrivateKey) return null;

  return Object.freeze({
    ...config,
    developerToken,
    connectorPrivateKey,
  });
}

export function publicHushhResearchConfig(env = process.env) {
  const config = readHushhResearchServerConfig(env);
  if (!config) return { enabled: false };

  return {
    enabled: true,
    firebase: { ...config.firebase },
    launch: {
      audience: config.audience,
      redirectUri: config.redirectUri,
      startPath: config.startPath,
    },
  };
}

export { UAT_CONTRACT };
