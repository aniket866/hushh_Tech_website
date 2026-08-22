import { RuntimeError } from "../errors.js";

const JSON_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json",
});
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SOURCE_PINS = Object.freeze({
  "ceo-calendar-booking": Object.freeze({ source: "063d336c9142cf5591f802da7c0eb8f508255e27a73bd2447e1a0a86f43b6559", live: "9a0626670fdff5690f4432d8d97e6e9839b71053da7b0ed712db8a17021646f6" }),
  "coins-credit-notification": Object.freeze({ source: "206932300bcee3c16dddd9f020c2295f3fb3d8d3eb41c748b32e3a308c353353", live: "d9ffdf0335cea5580514e4bf165fbf7746aa9a24ee0a7a2f57a4487ee5118a2b" }),
  "coins-deduction-notification": Object.freeze({ source: "b0dd1a82745024d78a90ab3e1921e5165a0d4b81eeb04ad22db8ab2661007cd6", live: "33d3f4948ae2515865bb9289f8e655aa26c9c7da19a1dc09bc01a37201e065f0" }),
  "create-verification-session": Object.freeze({ source: "9a5b6367e5b91ca3bc6675b9f72016f2c03ffbc835e16375167864c4dcda5408", live: "68d4e52cae53277f583bb3a13ee54f24f226120d176a1c93d444accce6b71b9d" }),
  "nda-signed-notification": Object.freeze({ source: "a7f7d6f4ee4619770bc1a6ea280e69289344631e857155d6274eaf1b873a7c7e", live: "71843e045083dc808bcb7f98eb1f7f0b1e79be800da66a9f330de46d692b11fc" }),
  "nws-score-notification": Object.freeze({ source: "43170a799dbd64acf59a0bd9a0956a9faba83783cf068980c566ae9222fedd2f", live: "864be3d6ea5bca2d666f4803fcca203b60a51fc3e330e335ad9d8a0fcb1e2533" }),
  "onboarding-funding-name-match": Object.freeze({ source: "f11f8ef2889f843fd6db4629dc707f1a28c6dfdfd1a9f49844ae2106a89a4293", live: "5005de2f287647ffe81bd473230aea0bdc81d2bff3995261ac940d1cb4909b7b" }),
  "onboarding-proof-of-funds": Object.freeze({ source: "810befa91b3ebf18fce29e020947ccf6df27755c457409e2271c9bd4c687ddb8", live: "4f54923d7b0b6eec86451bf1e5c8f1b8c5a2fe1ab3344b7abe46700e1477cd3c" }),
});

export const NOTIFY_WRITE_SOURCE_PINS = SOURCE_PINS;
export const NOTIFY_WRITE_SLUGS = Object.freeze(Object.keys(SOURCE_PINS).sort());

function json(status, body) {
  return Object.freeze({ status, headers: JSON_HEADERS, body });
}

function fail(code, message = "Service unavailable.", status = 503) {
  throw new RuntimeError(code, message, status);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
  }
}

function exactObject(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return value;
}

function text(value, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail("INVALID_REQUEST", "Invalid request.", 400);
    return null;
  }
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  const normalized = value.trim();
  if (required && !normalized) fail("INVALID_REQUEST", "Invalid request.", 400);
  return normalized || null;
}

function email(value, required = true) {
  const normalized = text(value, 320, { required });
  if (normalized && !EMAIL_PATTERN.test(normalized)) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return normalized?.toLowerCase() ?? null;
}

function finite(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return number;
}

function actorUid(actor) {
  if (actor?.kind === "firebase" && typeof actor.uid === "string" && actor.uid) return actor.uid;
  if (actor?.kind === "google-service") return null;
  fail("ACCESS_DENIED", "Access denied.", 403);
}

function requireEvidence(evidence, slug) {
  const pin = SOURCE_PINS[slug];
  const row = evidence?.[slug];
  if (
    row?.approved !== true ||
    row.sourceSha256 !== pin.source ||
    row.liveBundleSha256 !== pin.live
  ) {
    fail("CANDIDATE_EVIDENCE_REQUIRED");
  }
}

function requireProvider(provider, methods, code) {
  if (provider?.configured !== true || methods.some((name) => typeof provider[name] !== "function")) {
    fail(code);
  }
  return provider;
}

function requireDatabase(database) {
  if (typeof database?.transaction !== "function") fail("DATABASE_UNAVAILABLE");
  return database;
}

async function uidInTransaction(actor, client) {
  const direct = actorUid(actor);
  if (direct) return direct;
  const result = await client.query("SELECT current_setting('app.firebase_uid', true) AS user_id");
  const uid = result?.rows?.[0]?.user_id;
  if (typeof uid !== "string" || !uid || uid.length > 128) {
    fail("OWNERSHIP_CONTEXT_REQUIRED", "User ownership required.", 403);
  }
  return uid;
}

async function identityFor(identityDirectory, uid, signal) {
  const provider = requireProvider(identityDirectory, ["getUser"], "IDENTITY_DIRECTORY_UNAVAILABLE");
  const user = await provider.getUser(uid, { signal });
  throwIfAborted(signal);
  const rawEmail = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (user?.uid !== uid || !EMAIL_PATTERN.test(rawEmail) || rawEmail.length > 320) {
    fail("IDENTITY_RESPONSE_INVALID");
  }
  const userEmail = rawEmail;
  return Object.freeze({ uid, email: userEmail, name: text(user?.name, 160) || "Hushh User" });
}

function assertRecipient(actor, requested, identity) {
  if (actor?.kind === "firebase" && requested !== identity.email) {
    fail("RECIPIENT_MISMATCH", "Access denied.", 403);
  }
}

function safeSiteUrl(siteUrl, requested, fallbackPath) {
  let base;
  try {
    base = new URL(siteUrl);
  } catch {
    fail("SITE_CONFIGURATION_UNAVAILABLE");
  }
  if (base.protocol !== "https:" || !["hushhtech.com", "uat.hushhtech.com"].includes(base.hostname) || base.pathname !== "/") {
    fail("SITE_CONFIGURATION_UNAVAILABLE");
  }
  const fallback = new URL(fallbackPath, base).toString();
  if (!requested) return fallback;
  try {
    const value = new URL(requested, base);
    return value.origin === base.origin && !value.username && !value.password ? value.toString() : fallback;
  } catch {
    return fallback;
  }
}

function iso(value, { futureOf = null, maxFutureMs = null } = {}) {
  const raw = text(value, 64, { required: true });
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) fail("INVALID_REQUEST", "Invalid request.", 400);
  if (futureOf && date <= futureOf) fail("INVALID_REQUEST", "Invalid request.", 400);
  if (futureOf && maxFutureMs && date.getTime() - futureOf.getTime() > maxFutureMs) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return date;
}

function metadata(value) {
  if (value === undefined) return {};
  const object = exactObject(value, Object.keys(value));
  if (Object.keys(object).length > 24) fail("INVALID_REQUEST", "Invalid request.", 400);
  const output = {};
  for (const [key, item] of Object.entries(object)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || key === "user_id") {
      fail("INVALID_REQUEST", "Invalid request.", 400);
    }
    if (!["string", "number", "boolean"].includes(typeof item) || String(item).length > 256) {
      fail("INVALID_REQUEST", "Invalid request.", 400);
    }
    output[key] = item;
  }
  return output;
}

function normalizeName(raw) {
  const suffixes = new Set(["llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "lp", "llp", "plc", "trust", "the", "fbo", "foundation", "partners", "partnership", "holdings", "holding", "group", "fund", "and"]);
  return String(raw ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token && !suffixes.has(token)).join(" ");
}

function fundingNameStatus(expected, holders) {
  const target = normalizeName(expected);
  const candidates = holders.map(normalizeName).filter(Boolean);
  if (!target || candidates.length === 0) return "unavailable";
  const matches = (left, right) => {
    if (left === right) return true;
    const a = new Set(left.split(" "));
    const b = new Set(right.split(" "));
    const smaller = a.size <= b.size ? a : b;
    const larger = a.size <= b.size ? b : a;
    return smaller.size > 0 && [...smaller].every((token) => larger.has(token));
  };
  return candidates.some((candidate) => matches(candidate, target)) ? "match" : "mismatch";
}

function holderNames(identityData) {
  const output = [];
  for (const account of identityData?.accounts ?? []) {
    for (const owner of account?.owners ?? []) {
      for (const name of owner?.names ?? []) {
        const value = typeof name === "string" ? name.trim() : "";
        if (value && value.length <= 256) output.push(value);
      }
    }
  }
  return [...new Set(output)].slice(0, 64);
}

function commitmentCents(row) {
  const explicit = Number(row?.initial_investment_amount || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 100);
  const units = [row?.class_a_units, row?.class_b_units, row?.class_c_units].map((value) => Number(value || 0));
  if (units.some((value) => !Number.isFinite(value) || value < 0)) fail("DATABASE_RESPONSE_INVALID");
  return units[0] * 2_500_000_000 + units[1] * 500_000_000 + units[2] * 100_000_000;
}

function maxBalanceCents(rows) {
  let max = null;
  for (const row of rows ?? []) {
    const raw = row?.available_balance ?? row?.current_balance;
    if (raw === null || raw === undefined) continue;
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(cents)) continue;
    if (max === null || cents > max) max = cents;
  }
  return max;
}

export function createNotifyWriteBatchHandlers({
  evidence = null,
  calendar = null,
  mailer = null,
  identityDirectory = null,
  verificationProvider = null,
  siteUrl = null,
  now = () => new Date(),
} = {}) {
  const approved = (slug) => requireEvidence(evidence, slug);

  async function calendarBooking({ actor, request, database, signal }) {
    approved("ceo-calendar-booking");
    const provider = requireProvider(calendar, ["availability", "book"], "CALENDAR_PROVIDER_UNAVAILABLE");
    const uid = actorUid(actor);
    if (!uid) fail("ACCESS_DENIED", "Access denied.", 403);
    if (request.method === "GET") {
      const params = new URLSearchParams(request.route.search);
      const days = params.has("days") ? finite(params.get("days"), 1, 31) : 14;
      if (!Number.isInteger(days)) fail("INVALID_REQUEST", "Invalid request.", 400);
      const availability = await provider.availability({ days, signal });
      throwIfAborted(signal);
      if (!Array.isArray(availability)) fail("CALENDAR_RESPONSE_INVALID");
      return json(200, { success: true, ceo: { name: "Manish Sainani", email: "manish@hushh.ai" }, timezone: "America/Los_Angeles", meetingDuration: 60, availability });
    }
    const body = exactObject(request.body, ["startTime", "endTime", "attendeeName"], ["startTime", "endTime"]);
    const clock = now();
    if (!(clock instanceof Date) || Number.isNaN(clock.getTime())) fail("CLOCK_UNAVAILABLE");
    const start = iso(body.startTime, { futureOf: clock, maxFutureMs: 62 * 86_400_000 });
    const end = iso(body.endTime);
    if (end.getTime() - start.getTime() !== 3_600_000) fail("INVALID_REQUEST", "Invalid request.", 400);
    const identity = await identityFor(identityDirectory, uid, signal);
    const db = requireDatabase(database);
    await db.transaction(async (client) => client.query("SELECT 1 FROM public.ceo_meeting_payments WHERE user_id = $1 LIMIT 1", [uid]));
    const result = await provider.book({ startTime: start.toISOString(), endTime: end.toISOString(), attendeeEmail: identity.email, attendeeName: text(body.attendeeName, 160) || identity.name, requestId: request.requestId, signal });
    throwIfAborted(signal);
    const eventId = text(result?.eventId, 256, { required: true });
    const meetLink = text(result?.meetLink, 2_048);
    await db.transaction(async (client) => client.query(
      "UPDATE public.ceo_meeting_payments SET calendly_booked = TRUE, meeting_event_id = $2, meeting_start_time = $3, updated_at = $4 WHERE user_id = $1",
      [uid, eventId, start.toISOString(), clock.toISOString()],
    ));
    return json(200, { success: true, eventId, ...(meetLink ? { meetLink } : {}), startTime: start.toISOString(), endTime: end.toISOString(), message: `Meeting booked with Manish Sainani. Calendar invite sent to ${identity.email}.` });
  }

  async function notifyCoins(kind, { actor, request, signal }) {
    const slug = kind === "credit" ? "coins-credit-notification" : "coins-deduction-notification";
    approved(slug);
    const provider = requireProvider(mailer, ["send"], "MAIL_PROVIDER_UNAVAILABLE");
    const allowed = kind === "credit"
      ? ["recipientEmail", "recipientName", "coinsAwarded"]
      : ["recipientEmail", "recipientName", "coinsDeducted", "meetingDate", "meetingTime"];
    const amountKey = kind === "credit" ? "coinsAwarded" : "coinsDeducted";
    const body = exactObject(
      request.body,
      allowed,
      kind === "credit" ? ["recipientEmail", amountKey] : ["recipientEmail"],
    );
    const recipient = email(body.recipientEmail);
    const uid = actorUid(actor);
    const identity = uid ? await identityFor(identityDirectory, uid, signal) : null;
    if (identity) assertRecipient(actor, recipient, identity);
    const amount = body[amountKey] === undefined ? 300_000 : finite(body[amountKey], 1, 1_000_000_000_000);
    const result = await provider.send({ template: kind === "credit" ? "coins_credit" : "coins_deduction", recipients: [recipient], data: { recipientName: text(body.recipientName, 160) || identity?.name || "Hushh User", coins: amount, meetingDate: text(body.meetingDate, 64) || "TBD", meetingTime: text(body.meetingTime, 64) || "TBD" }, idempotencyKey: `${slug}:${request.requestId}`, signal });
    throwIfAborted(signal);
    if (result?.success !== true) return json(500, { error: text(result?.error, 512) || "Failed to send email" });
    return json(200, { success: true, message: kind === "credit" ? "Coins credit email sent" : "Deduction email sent", messageId: text(result.messageId, 256) });
  }

  async function verification({ actor, request, database, signal }) {
    approved("create-verification-session");
    const provider = requireProvider(verificationProvider, ["create"], "VERIFICATION_PROVIDER_UNAVAILABLE");
    const body = exactObject(request.body, ["email", "phone", "returnUrl", "metadata"]);
    const uid = actorUid(actor);
    if (!uid) fail("ACCESS_DENIED", "Access denied.", 403);
    const identity = await identityFor(identityDirectory, uid, signal);
    const requestedEmail = email(body.email, false);
    if (requestedEmail && requestedEmail !== identity.email) fail("RECIPIENT_MISMATCH", "Access denied.", 403);
    const phone = text(body.phone, 32);
    const safeReturnUrl = safeSiteUrl(siteUrl, body.returnUrl, "/onboarding/verify-complete");
    const db = requireDatabase(database);
    await db.transaction(async (client) => client.query("SELECT 1 FROM public.identity_verifications WHERE user_id = $1 LIMIT 1", [uid]));
    const session = await provider.create({ userId: uid, email: requestedEmail || identity.email, phone, returnUrl: safeReturnUrl, metadata: { ...metadata(body.metadata), user_id: uid }, idempotencyKey: `identity:${request.requestId}`, signal });
    throwIfAborted(signal);
    const sessionId = text(session?.id, 256, { required: true });
    const sessionUrl = text(session?.url, 2_048, { required: true });
    const status = text(session?.status, 64, { required: true });
    const clientSecret = text(session?.clientSecret, 2_048);
    const stored = await db.transaction(async (client) => client.query(
      "INSERT INTO public.identity_verifications (user_id, stripe_session_id, stripe_status, provided_email, provided_phone, stripe_response, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id) DO UPDATE SET stripe_session_id=EXCLUDED.stripe_session_id, stripe_status=EXCLUDED.stripe_status, provided_email=EXCLUDED.provided_email, provided_phone=EXCLUDED.provided_phone, stripe_response=EXCLUDED.stripe_response RETURNING id",
      [uid, sessionId, status, requestedEmail || identity.email, phone, { id: sessionId, status, type: session?.type ?? null, created: session?.created ?? null }, now().toISOString()],
    ));
    const verificationId = stored?.rows?.[0]?.id;
    if (!verificationId) fail("DATABASE_RESPONSE_INVALID");
    return json(200, { success: true, session: { id: sessionId, url: sessionUrl, status, ...(clientSecret ? { client_secret: clientSecret } : {}) }, verification_id: verificationId });
  }

  async function ndaNotification({ actor, request, database, signal }) {
    approved("nda-signed-notification");
    const provider = requireProvider(mailer, ["send"], "MAIL_PROVIDER_UNAVAILABLE");
    const body = exactObject(request.body, ["signerName", "signedAt", "ndaVersion", "pdfUrl", "pdfBase64", "documentsAcknowledged", "userAgent", "signatureId", "signedAtLocal", "consentVersion"], ["signerName"]);
    const signerName = text(body.signerName, 160, { required: true });
    const pdf = text(body.pdfBase64, 900_000);
    if (pdf && (!BASE64_PATTERN.test(pdf) || Buffer.from(pdf, "base64").length > 675_000)) fail("INVALID_REQUEST", "Invalid request.", 400);
    const documents = body.documentsAcknowledged ?? [];
    if (!Array.isArray(documents) || documents.length > 32 || documents.some((item) => !text(item, 160, { required: true }))) fail("INVALID_REQUEST", "Invalid request.", 400);
    const db = requireDatabase(database);
    let uid;
    await db.transaction(async (client) => {
      uid = await uidInTransaction(actor, client);
      await client.query("UPDATE public.nda_signatures SET signature_id = $2, signer_user_agent = $3, updated_at = $4 WHERE user_id = $1", [uid, text(body.signatureId, 256), text(body.userAgent, 1_024), now().toISOString()]);
    });
    const identity = await identityFor(identityDirectory, uid, signal);
    const adminRecipients = Array.isArray(provider.adminRecipients) ? provider.adminRecipients.map((value) => email(value)) : [];
    if (adminRecipients.length < 1 || adminRecipients.length > 16) fail("MAIL_PROVIDER_UNAVAILABLE");
    const data = { signerName, signerEmail: identity.email, signedAt: text(body.signedAt, 64) || now().toISOString(), ndaVersion: text(body.ndaVersion, 128), pdfUrl: text(body.pdfUrl, 2_048), pdfBase64: pdf, documentsAcknowledged: documents, userAgent: text(body.userAgent, 1_024), signatureId: text(body.signatureId, 256), signedAtLocal: text(body.signedAtLocal, 128), consentVersion: text(body.consentVersion, 128) };
    const admin = await provider.send({ template: "nda_admin", recipients: adminRecipients, data, idempotencyKey: `nda-admin:${request.requestId}`, signal });
    const signer = await provider.send({ template: "nda_signer", recipients: [identity.email], data, idempotencyKey: `nda-signer:${request.requestId}`, signal });
    throwIfAborted(signal);
    await db.transaction(async (client) => {
      for (const [type, recipients, result] of [["nda_admin", adminRecipients, admin], ["nda_signer", [identity.email], signer]]) {
        await client.query("INSERT INTO public.fund_payment_notifications (user_id, notification_type, recipient_email, subject, status, provider_message_id, error_message, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [uid, type, recipients.join(", "), type === "nda_admin" ? `[Hushh NDA] Agreement Signed by ${signerName}` : "Your signed NDA — Hushh Technologies", result?.success === true ? "sent" : "failed", result?.messageId ?? null, result?.error ?? null, result?.success === true ? now().toISOString() : null]);
      }
    });
    return json(200, { success: true, adminSent: admin?.success === true, signerSent: signer?.success === true, pdfMissing: !pdf, email_delivery: { admin: { success: admin?.success === true, error: admin?.error ?? null, recipients: adminRecipients }, signer: { success: signer?.success === true, error: signer?.error ?? null } } });
  }

  async function nwsNotification({ actor, request, signal }) {
    approved("nws-score-notification");
    const provider = requireProvider(mailer, ["send"], "MAIL_PROVIDER_UNAVAILABLE");
    const keys = ["user_email", "user_name", "nws_score", "nws_tier", "total_cash_balance", "total_investment_value", "num_accounts", "account_types", "primary_institution", "address_city", "address_state", "identity_verification_score", "profile_url"];
    const body = exactObject(request.body, keys, ["user_email", "user_name", "nws_score", "nws_tier", "total_cash_balance", "total_investment_value", "num_accounts", "account_types"]);
    const recipient = email(body.user_email);
    const uid = actorUid(actor);
    const identity = uid ? await identityFor(identityDirectory, uid, signal) : null;
    if (identity) assertRecipient(actor, recipient, identity);
    if (!Array.isArray(body.account_types) || body.account_types.length > 32 || body.account_types.some((item) => !text(item, 64, { required: true }))) fail("INVALID_REQUEST", "Invalid request.", 400);
    const data = { user_name: text(body.user_name, 160, { required: true }), nws_score: finite(body.nws_score, 0, 100), nws_tier: text(body.nws_tier, 64, { required: true }), total_cash_balance: finite(body.total_cash_balance, 0, 1e15), total_investment_value: finite(body.total_investment_value, 0, 1e15), num_accounts: finite(body.num_accounts, 0, 10_000), account_types: body.account_types, primary_institution: text(body.primary_institution, 160), address_city: text(body.address_city, 160), address_state: text(body.address_state, 160), identity_verification_score: body.identity_verification_score == null ? null : finite(body.identity_verification_score, 0, 100), profile_url: safeSiteUrl(siteUrl, body.profile_url, "/hushh-user-profile") };
    const result = await provider.send({ template: "nws_score", recipients: [recipient], data, idempotencyKey: `nws:${request.requestId}`, signal });
    if (result?.success !== true) return json(500, { error: "Failed to send email", details: text(result?.error, 512) });
    return json(200, { success: true, email_id: text(result.messageId, 256) });
  }

  async function fundingNameMatch({ actor, request, database, signal }) {
    approved("onboarding-funding-name-match");
    exactObject(request.body ?? {}, []);
    const db = requireDatabase(database);
    return db.transaction(async (client) => {
      const uid = await uidInTransaction(actor, client);
      const onboarding = (await client.query("SELECT account_structure, entity_legal_name, custodian_name, legal_first_name, legal_last_name FROM public.onboarding_data WHERE user_id = $1 LIMIT 1", [uid]))?.rows?.[0] ?? null;
      const structure = String(onboarding?.account_structure ?? "");
      const expected = structure === "trust" ? onboarding?.entity_legal_name : structure === "retirement" ? onboarding?.custodian_name : null;
      if (!expected) return json(200, { success: true, applicable: false, status: "unavailable" });
      const financial = (await client.query("SELECT identity_data FROM public.user_financial_data WHERE user_id = $1 LIMIT 1", [uid]))?.rows?.[0] ?? null;
      const holders = holderNames(financial?.identity_data);
      const status = fundingNameStatus(expected, holders);
      const registration = structure === "retirement" ? `${String(onboarding.custodian_name).trim()} FBO ${[onboarding.legal_first_name, onboarding.legal_last_name].filter(Boolean).join(" ").trim() || "Investor"} IRA` : null;
      await client.query("UPDATE public.onboarding_data SET funding_name_match_status=$2, funding_account_holder_name=$3, retirement_registration_name=COALESCE($4, retirement_registration_name), manual_review_route=CASE WHEN $2='mismatch' THEN TRUE ELSE manual_review_route END, updated_at=$5 WHERE user_id=$1", [uid, status, holders[0] ?? null, registration, now().toISOString()]);
      throwIfAborted(signal);
      return json(200, { success: true, applicable: true, status, holder_name_available: holders.length > 0 });
    });
  }

  async function proofOfFunds({ actor, request, database, signal }) {
    approved("onboarding-proof-of-funds");
    exactObject(request.body ?? {}, []);
    const db = requireDatabase(database);
    return db.transaction(async (client) => {
      const uid = await uidInTransaction(actor, client);
      const onboarding = (await client.query("SELECT initial_investment_amount, class_a_units, class_b_units, class_c_units FROM public.onboarding_data WHERE user_id=$1 LIMIT 1", [uid]))?.rows?.[0] ?? null;
      const investment = onboarding ? commitmentCents(onboarding) : 0;
      const financial = (await client.query("SELECT plaid_item_id FROM public.user_financial_data WHERE user_id=$1 LIMIT 1", [uid]))?.rows?.[0] ?? null;
      const accounts = financial?.plaid_item_id ? (await client.query("SELECT current_balance, available_balance FROM public.plaid_accounts WHERE plaid_item_id=$1", [financial.plaid_item_id]))?.rows ?? [] : [];
      const balance = maxBalanceCents(accounts);
      const status = !balance || balance <= 0 || !investment || investment <= 0 ? "balance_unavailable" : balance >= investment ? "funds_sufficient" : "funds_insufficient";
      throwIfAborted(signal);
      return json(200, { success: true, status, balance_available: balance !== null, investment_selected: investment > 0 });
    });
  }

  return Object.freeze({
    "ceo-calendar-booking": calendarBooking,
    "coins-credit-notification": (context) => notifyCoins("credit", context),
    "coins-deduction-notification": (context) => notifyCoins("deduction", context),
    "create-verification-session": verification,
    "nda-signed-notification": ndaNotification,
    "nws-score-notification": nwsNotification,
    "onboarding-funding-name-match": fundingNameMatch,
    "onboarding-proof-of-funds": proofOfFunds,
  });
}
