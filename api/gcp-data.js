import { executeDataRequest, verifyFirebaseBearer } from "./shared/gcpDataRuntime.js";
import { executeNdaRequest } from "./shared/gcpNdaRuntime.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required." } });
  try {
    const actor = await verifyFirebaseBearer(req.headers.authorization);
    const result = req.body?.kind === "nda"
      ? await executeNdaRequest(req.body, actor, {
        // Do not trust arbitrary forwarded headers for evidence. Until the
        // deployment's trusted proxy chain is attested, retain unknown IP.
        userAgent: req.headers["user-agent"],
      })
      : await executeDataRequest(req.body, actor.uid);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch (error) {
    const invalidIdentity = ["auth/id-token-revoked", "auth/id-token-expired", "auth/invalid-id-token", "auth/user-disabled", "auth/user-not-found", "auth/argument-error"].includes(error?.code);
    const status = invalidIdentity ? 401 : Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({ error: {
      code: invalidIdentity ? "AUTH_INVALID" : error?.code || "GCP_DATA_ERROR",
      message: invalidIdentity ? "Please sign in again." : status >= 500 ? "GCP data service unavailable." : error.message,
    } });
  }
}
