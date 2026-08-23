import { executeDataRequest, verifyFirebaseBearer } from "./shared/gcpDataRuntime.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required." } });
  try {
    const actor = await verifyFirebaseBearer(req.headers.authorization);
    const result = await executeDataRequest(req.body, actor.uid);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return res.status(status).json({ error: { code: error?.code || "GCP_DATA_ERROR", message: status >= 500 ? "GCP data service unavailable." : error.message } });
  }
}
