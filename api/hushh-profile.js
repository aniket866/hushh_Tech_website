import { verifyFirebaseBearer } from "./shared/gcpDataRuntime.js";
import {
  getOwnProfile,
  PROFILE_DATA_CONTRACT_NOT_READY,
  updateOwnProfile,
} from "./shared/hushhProfileRepository.js";

const IDENTITY_FIELDS = new Set([
  "id",
  "userId",
  "user_id",
  "firebase_uid",
  "database_id",
  "hushh_id",
]);

function sendError(res, error, fallbackCode = "PROFILE_API_ERROR") {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code = typeof error?.code === "string" ? error.code : fallbackCode;
  const message = status === 401
    ? "Authentication required."
    : status >= 500
      ? "Profile data is temporarily unavailable."
      : error?.message || "Profile request is invalid.";
  return res.status(status).json({ error: { code, message } });
}

async function authenticate(req, res) {
  if (!/^Bearer\s+[^\s]+$/i.test(String(req.headers?.authorization || ""))) {
    sendError(res, { status: 401, code: "AUTH_REQUIRED" }, "AUTH_REQUIRED");
    return null;
  }
  try {
    return await verifyFirebaseBearer(req.headers?.authorization);
  } catch (error) {
    const authError = error && typeof error === "object" ? error : {};
    sendError(res, { ...authError, status: authError.status || 401, code: authError.code || "AUTH_INVALID" }, "AUTH_INVALID");
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "GET or PUT required." } });
  }

  const actor = await authenticate(req, res);
  if (!actor) return;

  try {
    if (req.method === "GET") {
      const profile = await getOwnProfile(actor.uid);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ data: profile });
    }

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
      return res.status(400).json({ error: { code: "INVALID_PROFILE_INPUT", message: "Profile input is invalid." } });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: { code: "INVALID_PROFILE_INPUT", message: "Profile input is invalid." } });
    }
    if (Object.keys(body).some((key) => IDENTITY_FIELDS.has(key))) {
      return res.status(400).json({ error: { code: "IDENTITY_FIELDS_NOT_ALLOWED", message: "Profile identity is managed by authentication." } });
    }
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      return res.status(400).json({ error: { code: "INVALID_PROFILE_INPUT", message: "Profile input is invalid." } });
    }

    const payload = {
      profile: body.profile,
      ...(typeof body.name === "string" || body.name === null ? { name: body.name } : {}),
      ...(typeof body.organisation === "string" || body.organisation === null ? { organisation: body.organisation } : {}),
    };
    const profile = await updateOwnProfile(actor.uid, payload);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ data: profile });
  } catch (error) {
    return sendError(res, error, PROFILE_DATA_CONTRACT_NOT_READY);
  }
}
