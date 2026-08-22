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
    const { adminClient, auditSecret } = createDeleteAccountAdminClientFromEnv();
    const result = await executeDeleteAccount({
      adminClient,
      authHeader,
      auditSecret,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("delete-account route error:", message);

    return res.status(500).json({
      success: false,
      error: "Server configuration error",
      details: message,
    });
  }
}
