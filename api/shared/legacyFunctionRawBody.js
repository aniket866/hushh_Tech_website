import express from "express";

export function createLegacyFunctionRawBodyParser({ limit = "10mb" } = {}) {
  return express.raw({ type: () => true, limit, inflate: false });
}

export function preserveLegacyFunctionRawBody(req, _res, next) {
  if (Buffer.isBuffer(req.body)) req.rawBody = Buffer.from(req.body);
  next();
}

export function legacyFunctionParserError(error, req, res, next) {
  if (!req.originalUrl?.startsWith("/functions/v1/")) return next(error);

  const tooLarge = error?.type === "entity.too.large";
  const unsupportedEncoding = error?.type === "encoding.unsupported";
  const status = tooLarge ? 413 : unsupportedEncoding ? 415 : 400;
  const code = tooLarge
    ? "PAYLOAD_TOO_LARGE"
    : unsupportedEncoding
      ? "UNSUPPORTED_MEDIA_TYPE"
      : "INVALID_BODY";
  const message = tooLarge
    ? "Request is too large."
    : unsupportedEncoding
      ? "Unsupported request type."
      : "Invalid request body.";
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json({
    detail: {
      code,
      message,
    },
  });
}
