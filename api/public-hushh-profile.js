import {
  getPublicProfile,
  PUBLIC_HUSHH_ID_CONTRACT_NOT_READY,
} from "./shared/hushhProfileRepository.js";

const HUSHH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "GET required." } });
  }

  const hushhId = typeof req.params?.hushhId === "string" ? req.params.hushhId : "";
  if (!HUSHH_ID.test(hushhId)) {
    return res.status(400).json({ error: { code: "INVALID_HUSHH_ID", message: "This Hushh ID is invalid." } });
  }

  try {
    const profile = await getPublicProfile(hushhId);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ data: profile });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    const code = typeof error?.code === "string" ? error.code : PUBLIC_HUSHH_ID_CONTRACT_NOT_READY;
    return res.status(status).json({
      error: {
        code,
        message: status >= 500 ? "This public profile is temporarily unavailable." : "Public profile request is invalid.",
      },
    });
  }
}
