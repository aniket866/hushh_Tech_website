import { createHash } from "node:crypto";

import { RuntimeError } from "../errors.js";

const PRIVATE_JSON_HEADERS = Object.freeze({
  "content-type": "application/json",
  "cache-control": "private, no-store",
});
const USER_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function json(status, body) {
  return Object.freeze({ status, headers: PRIVATE_JSON_HEADERS, body });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

function requestInput(body) {
  if (body === null || body === undefined) return Object.freeze({});
  if (
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "highlightUserId")
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  const highlightUserId = body.highlightUserId;
  if (
    highlightUserId !== undefined &&
    (typeof highlightUserId !== "string" ||
      !USER_REFERENCE_PATTERN.test(highlightUserId))
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }
  return Object.freeze({
    ...(highlightUserId === undefined ? {} : { highlightUserId }),
  });
}

function recordId(sourceId) {
  return `nda_${createHash("sha256")
    .update(`hushh-tech-uat-nda-record-v1\0${sourceId}`, "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

function projectRecord(row) {
  const sourceId = String(row?.source_id ?? "").trim();
  const date =
    row?.signed_at instanceof Date
      ? row.signed_at
      : new Date(String(row?.signed_at ?? ""));
  const version = row?.nda_version;
  if (
    !sourceId ||
    sourceId.length > 128 ||
    Number.isNaN(date.getTime()) ||
    (version !== null &&
      version !== undefined &&
      (typeof version !== "string" || version.length > 128)) ||
    typeof row?.pdf_available !== "boolean" ||
    typeof row?.highlighted !== "boolean"
  ) {
    throw new RuntimeError(
      "DATABASE_RESPONSE_INVALID",
      "Records unavailable.",
      503,
    );
  }
  return Object.freeze({
    record_id: recordId(sourceId),
    signed_at: date.toISOString(),
    nda_version: version ?? null,
    pdf_available: row.pdf_available,
    highlighted: row.highlighted,
  });
}

export function createNdaAdminFetchHandler() {
  return async function ndaAdminFetch({
    actor,
    request,
    database,
    signal,
  }) {
    if (actor?.kind !== "firebase" || actor.fundAdmin !== true) {
      throw new RuntimeError("ACCESS_DENIED", "Access denied.", 403);
    }
    if (typeof database?.transaction !== "function") {
      throw new RuntimeError(
        "DATABASE_UNAVAILABLE",
        "Records unavailable.",
        503,
      );
    }
    const input = requestInput(request?.body);
    throwIfAborted(signal);
    const rows = await database.transaction(async (client, transactionSignal) => {
      throwIfAborted(transactionSignal);
      const result = await client.query(
        `SELECT
           id::text AS source_id,
           signed_at,
           nda_version,
           (pdf_url IS NOT NULL AND btrim(pdf_url) <> '') AS pdf_available,
           ($1::text IS NOT NULL AND user_id::text = $1::text) AS highlighted
         FROM public.nda_signatures
         WHERE signed_at IS NOT NULL
         ORDER BY signed_at DESC, id DESC`,
        [input.highlightUserId ?? null],
      );
      throwIfAborted(transactionSignal);
      if (!Array.isArray(result?.rows)) {
        throw new RuntimeError(
          "DATABASE_RESPONSE_INVALID",
          "Records unavailable.",
          503,
        );
      }
      return result.rows.map(projectRecord);
    });
    throwIfAborted(signal);
    return json(200, {
      success: true,
      records: rows,
      count: rows.length,
    });
  };
}
