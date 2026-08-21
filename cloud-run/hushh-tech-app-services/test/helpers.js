import { once } from "node:events";

export const VALID_TOKEN = "x".repeat(64);

export function runtimeEnv(overrides = {}) {
  return {
    SERVICE_OWNER: "identity-api",
    GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
    CLOUD_RUN_INGRESS_MODE: "internal",
    PRIVATE_INGRESS_ENFORCED: "true",
    SERVICE_AUDIENCE:
      "https://hushh-tech-identity-api-175298245599.us-central1.run.app",
    ALLOWED_GOOGLE_CALLERS:
      "hushh-tech-gateway-uat@hushh-tech-uat.iam.gserviceaccount.com",
    FIREBASE_PROJECT_ID: "hushh-pda",
    PRODUCT_AUDIENCE: "hushh-tech-uat",
    PRODUCT_CLIENT_APP_ID: "app_hushh-technologies_cd1895ef",
    INSTANCE_CONNECTION_NAME:
      "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
    PGDATABASE: "hushh_tech_app",
    PGUSER: "hushh-tech-identity-api-uat@hushh-tech-uat.iam",
    ...overrides,
  };
}

export async function request(app, path, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { response, body, text };
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export function errorCode(result) {
  return result.body?.detail?.code;
}
