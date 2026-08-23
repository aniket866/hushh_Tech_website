import {
  createDeleteAccountAdminClientFromEnv,
  executeDeleteAccount,
} from "./delete-account-service.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization || null;

  try {
    const { adminClient, auditSecret, storageAdapter } =
      createDeleteAccountAdminClientFromEnv();
    const result = await executeDeleteAccount({
      adminClient,
      authHeader,
      auditSecret,
      storageAdapter,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" ? error.code : null;
    console.error("delete-account route error:", message);

    const storageDisabled = code === "GCP_DELETE_ACCOUNT_STORAGE_DISABLED";
    return res.status(storageDisabled ? 503 : 500).json({
      success: false,
      error: storageDisabled
        ? "Account deletion is temporarily unavailable"
        : "Server configuration error",
      details: storageDisabled ? code : message,
    });
  }
}
