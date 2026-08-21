import { RuntimeError } from "./errors.js";

export const WEBHOOK_CONTRACTS = Object.freeze({
  "fund-stripe-webhook": Object.freeze({
    provider: "stripe",
    requiredHeaders: Object.freeze(["stripe-signature"]),
  }),
  "github-devops-notify": Object.freeze({
    provider: "github",
    requiredHeaders: Object.freeze([
      "x-hub-signature-256",
      "x-github-delivery",
    ]),
  }),
  "identity-verification-webhook": Object.freeze({
    provider: "stripe-identity",
    requiredHeaders: Object.freeze(["stripe-signature"]),
  }),
  "plaid-data-webhook": Object.freeze({
    provider: "plaid",
    requiredHeaders: Object.freeze(["plaid-verification"]),
  }),
  "plaid-transfer-webhook": Object.freeze({
    provider: "plaid",
    requiredHeaders: Object.freeze(["plaid-verification"]),
  }),
  "stripe-identity-webhook": Object.freeze({
    provider: "stripe-identity",
    requiredHeaders: Object.freeze(["stripe-signature"]),
  }),
});

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : String(value ?? "").trim();
}

function verificationRejected() {
  return new RuntimeError(
    "WEBHOOK_SIGNATURE_INVALID",
    "Webhook rejected.",
    401,
  );
}

export function createWebhookVerifier({ verifiers = {} } = {}) {
  return async function verifyWebhookRequest(request, entry) {
    const contract = WEBHOOK_CONTRACTS[entry.slug];
    if (!contract || entry.auth_mode !== "provider_signature_raw_body") {
      throw new RuntimeError("INVALID_ROUTE", "Not found.", 404);
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
    }

    const headers = Object.freeze(
      Object.fromEntries(
        contract.requiredHeaders.map((name) => {
          const value = headerValue(request.headers, name);
          if (!value || value.length > 8_192) throw verificationRejected();
          return [name, value];
        }),
      ),
    );
    const verifier = verifiers[entry.slug];
    if (typeof verifier !== "function") {
      throw new RuntimeError(
        "WEBHOOK_VERIFIER_UNAVAILABLE",
        "Webhook unavailable.",
        503,
      );
    }

    let result;
    try {
      result = await verifier({
        provider: contract.provider,
        rawBody: request.body,
        headers,
      });
    } catch (error) {
      throw new RuntimeError(
        "WEBHOOK_SIGNATURE_INVALID",
        "Webhook rejected.",
        401,
        { cause: error },
      );
    }
    const eventId = String(result?.eventId ?? "").trim();
    if (result?.verified !== true || !eventId || eventId.length > 256) {
      throw verificationRejected();
    }

    return Object.freeze({
      kind: "provider-webhook",
      provider: contract.provider,
      eventId,
      event: result.event,
    });
  };
}
