import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { withFirebaseTransaction } from "./gcpDataRuntime.js";
import { ensureApplicationPrincipal, prepareIdentityEvidence } from "./gcpIdentityProvisioning.js";

export const NDA_VERSION = "v1.0";
export const NDA_DOCUMENTS = Object.freeze([
  "Hushh Alpha Aloha Fund A Delaware Feeder LPA",
  "Hushh Alpha Aloha Fund A Investment Prospectus",
  "Hushh Alpha Aloha Fund A LP Master LPA",
  "Hushh Alpha Aloha Fund A PPM",
]);

const fail = (message, code = "NDA_REQUEST_INVALID", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const isControl = (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;

export function validateNdaRequest(request, uid) {
  if (!exactKeys(request, ["kind", "operation", "signing"]) || request.kind !== "nda" ||
      !["status", "record", "sign"].includes(request.operation)) fail("Invalid NDA operation.");
  if (request.operation !== "sign") {
    if (request.signing !== undefined) fail("Unexpected signing data.");
    return null;
  }
  const signing = request.signing;
  if (!exactKeys(signing, ["signerName", "ndaVersion", "consentVersion", "consentAccepted", "documentsAcknowledged", "pdfUrl"])) fail("Invalid signing data.");
  const name = typeof signing.signerName === "string" ? signing.signerName.trim() : "";
  if (name.length < 2 || name.length > 100 || [...name].some(isControl)) fail("Enter your full legal name (2–100 characters).");
  if (signing.ndaVersion !== NDA_VERSION || signing.consentVersion !== NDA_VERSION) fail("The NDA version has changed. Reload and review the agreements.");
  if (signing.consentAccepted !== true) fail("Explicit consent is required.");
  const docs = signing.documentsAcknowledged;
  if (!Array.isArray(docs) || docs.length !== NDA_DOCUMENTS.length || new Set(docs).size !== NDA_DOCUMENTS.length ||
      !NDA_DOCUMENTS.every((doc) => docs.includes(doc))) fail("Acknowledge all required fund documents.");
  let pdfUrl = signing.pdfUrl ?? null;
  if (pdfUrl !== null) {
    // Only a persisted, caller-owned object served by the existing GCP storage
    // route is accepted. No external URLs, blob URLs, query strings or traversal.
    if (typeof pdfUrl !== "string" || pdfUrl.length > 1024 || !uid || uid.includes('/') || uid.includes('\\') || [...uid].some(isControl)) fail("Invalid PDF reference.");
    const prefix = `/api/gcp/storage/assets/${encodeURIComponent(uid)}/signed-ndas/`;
    if (!pdfUrl.startsWith(prefix) || !/^nda_[A-Za-z0-9_-]+_[0-9]+\.pdf$/.test(pdfUrl.slice(prefix.length))) fail("Invalid PDF reference.");
  }
  return { signerName: name, ndaVersion: NDA_VERSION, consentVersion: NDA_VERSION, documents: [...NDA_DOCUMENTS], pdfUrl };
}

const iso = (value) => value == null ? null : new Date(value).toISOString();
const ndaRecord = (row) => row ? ({ signerName: row.signer_name, ndaVersion: row.nda_version, signedAt: iso(row.signed_at), pdfUrl: row.pdf_url }) : null;

export async function executeNdaRequest(request, actor, metadata = {}, dependencies = {}) {
  const signing = validateNdaRequest(request, actor.uid);
  const evidence = await prepareIdentityEvidence(actor, dependencies);
  return withFirebaseTransaction(actor.uid, async (client) => {
    const principal = await ensureApplicationPrincipal(client, evidence);
    // Identity function serializes same-actor requests; a transaction lock on
    // the application UUID also makes first sign/retry/version change atomic.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`nda:${principal.application_user_id}`]);
    const { rows } = await client.query(
      "SELECT signer_name, nda_version, signed_at, pdf_url, consent_version, documents_acknowledged, signature_id FROM public.nda_signatures WHERE user_id=$1::uuid FOR UPDATE",
      [principal.application_user_id],
    );
    const existing = rows[0];
    if (request.operation === "record") return { data: ndaRecord(existing) };
    if (request.operation === "status") return { data: {
      hasSignedNda: Boolean(existing?.signed_at), signedAt: iso(existing?.signed_at),
      ndaVersion: existing?.nda_version ?? null, signerName: existing?.signer_name ?? null,
    } };

    if (existing?.signed_at && existing.nda_version === NDA_VERSION) {
      const identical = existing.signer_name === signing.signerName && existing.consent_version === signing.consentVersion &&
        Array.isArray(existing.documents_acknowledged) && existing.documents_acknowledged.length === NDA_DOCUMENTS.length &&
        new Set(existing.documents_acknowledged).size === NDA_DOCUMENTS.length && NDA_DOCUMENTS.every((doc) => existing.documents_acknowledged.includes(doc));
      if (!identical) fail("Existing consent differs. Contact support before replacing signed evidence.", "NDA_EVIDENCE_CONFLICT", 409);
      // PDF retries may produce another object. Never replace committed evidence.
      return { data: { success: true, ...ndaRecord(existing), shouldNotify: false, wasInserted: false, versionChanged: false } };
    }
    const ip = typeof metadata.ip === "string" && isIP(metadata.ip) ? metadata.ip : "unknown";
    const userAgent = typeof metadata.userAgent === "string" ? [...metadata.userAgent].filter((character) => !isControl(character)).join('').slice(0, 512) : null;
    const result = await client.query(
      `INSERT INTO public.nda_signatures (user_id, signer_name, signer_email, signer_ip, nda_version, pdf_url, documents_acknowledged, consent_version, signer_user_agent, signature_id, signed_at, updated_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,clock_timestamp(),clock_timestamp())
       ON CONFLICT (user_id) DO UPDATE SET signer_name=EXCLUDED.signer_name, signer_email=EXCLUDED.signer_email, signer_ip=EXCLUDED.signer_ip, nda_version=EXCLUDED.nda_version, pdf_url=EXCLUDED.pdf_url, documents_acknowledged=EXCLUDED.documents_acknowledged, consent_version=EXCLUDED.consent_version, signer_user_agent=EXCLUDED.signer_user_agent, signature_id=EXCLUDED.signature_id, signed_at=EXCLUDED.signed_at, updated_at=EXCLUDED.updated_at
       RETURNING signer_name, nda_version, signed_at, pdf_url`,
      [principal.application_user_id, signing.signerName, actor.email || null, ip, NDA_VERSION, signing.pdfUrl, JSON.stringify(signing.documents), signing.consentVersion, userAgent, `sig_${randomUUID()}`],
    );
    if (result.rows.length !== 1) fail("Consent could not be persisted.", "NDA_PERSISTENCE_FAILED", 503);
    return { data: { success: true, ...ndaRecord(result.rows[0]), shouldNotify: true, wasInserted: !existing, versionChanged: Boolean(existing && existing.nda_version !== NDA_VERSION) } };
  }, dependencies);
}
