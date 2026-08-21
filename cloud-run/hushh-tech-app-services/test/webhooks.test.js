import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeError } from "../src/errors.js";
import {
  createWebhookVerifier,
  WEBHOOK_CONTRACTS,
} from "../src/webhooks.js";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

test("all six webhook seams verify the exact raw bytes before parsing", async () => {
  assert.equal(Object.keys(WEBHOOK_CONTRACTS).length, 6);
  const rawBody = Buffer.from('{"amount":100,"space":"a  b"}', "utf8");
  for (const [slug, contract] of Object.entries(WEBHOOK_CONTRACTS)) {
    let observed = null;
    const verify = createWebhookVerifier({
      verifiers: {
        [slug]: async (input) => {
          observed = input;
          return {
            verified: true,
            eventId: `${slug}-event-1`,
            event: { type: "verified" },
          };
        },
      },
    });
    const headers = Object.fromEntries(
      contract.requiredHeaders.map((name) => [name, `${name}-value`]),
    );
    const actor = await verify(
      { headers, body: rawBody },
      { slug, auth_mode: "provider_signature_raw_body" },
    );
    assert.equal(observed.rawBody, rawBody);
    assert.equal(observed.rawBody.equals(rawBody), true);
    assert.equal(observed.provider, contract.provider);
    assert.deepEqual(Object.keys(observed.headers), contract.requiredHeaders);
    assert.equal(actor.kind, "provider-webhook");
    assert.equal(actor.eventId, `${slug}-event-1`);
  }
});

test("webhook verification fails closed for missing bytes, headers, or verifier", async () => {
  const entry = {
    slug: "fund-stripe-webhook",
    auth_mode: "provider_signature_raw_body",
  };
  const unavailable = createWebhookVerifier();
  await assert.rejects(
    unavailable(
      { body: Buffer.from("{}"), headers: { "stripe-signature": "valid" } },
      entry,
    ),
    (error) => runtimeCode(error, "WEBHOOK_VERIFIER_UNAVAILABLE", 503),
  );
  await assert.rejects(
    unavailable({ body: Buffer.from("{}"), headers: {} }, entry),
    (error) => runtimeCode(error, "WEBHOOK_SIGNATURE_INVALID", 401),
  );
  await assert.rejects(
    unavailable(
      { body: { parsed: true }, headers: { "stripe-signature": "valid" } },
      entry,
    ),
    (error) => runtimeCode(error, "INVALID_REQUEST", 400),
  );
});

test("webhook verifier rejection and missing event identity are denied", async () => {
  const entry = {
    slug: "github-devops-notify",
    auth_mode: "provider_signature_raw_body",
  };
  const request = {
    body: Buffer.from("raw"),
    headers: {
      "x-hub-signature-256": "sha256=signature",
      "x-github-delivery": "delivery-1",
    },
  };
  const throws = createWebhookVerifier({
    verifiers: {
      "github-devops-notify": async () => {
        throw new Error("bad signature");
      },
    },
  });
  await assert.rejects(
    throws(request, entry),
    (error) => runtimeCode(error, "WEBHOOK_SIGNATURE_INVALID", 401),
  );

  const noEventId = createWebhookVerifier({
    verifiers: {
      "github-devops-notify": async () => ({ verified: true }),
    },
  });
  await assert.rejects(
    noEventId(request, entry),
    (error) => runtimeCode(error, "WEBHOOK_SIGNATURE_INVALID", 401),
  );
});
