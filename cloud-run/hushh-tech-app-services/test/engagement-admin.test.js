import assert from "node:assert/strict";
import test from "node:test";

import { FUNCTION_CONTRACTS } from "../src/contracts.js";
import { RuntimeError } from "../src/errors.js";
import { createNdaAdminFetchHandler } from "../src/handlers/engagement-admin.js";
import { createRuntimeHandlers } from "../src/runtime-handlers.js";

function runtimeCode(error, code, statusCode) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

const ADMIN = Object.freeze({
  kind: "firebase",
  uid: "firebase-admin-1",
  fundAdmin: true,
});

function request(body = {}) {
  return Object.freeze({ body });
}

test("NDA admin requires the literal verified fund admin actor before database access", async () => {
  const handler = createNdaAdminFetchHandler();
  let transactions = 0;
  const database = {
    transaction: async () => {
      transactions += 1;
    },
  };
  for (const actor of [
    null,
    { kind: "firebase", uid: "user", fundAdmin: false },
    { kind: "firebase", uid: "user", fundAdmin: "true" },
    { kind: "google", fundAdmin: true },
  ]) {
    await assert.rejects(
      handler({ actor, request: request(), database }),
      (error) => runtimeCode(error, "ACCESS_DENIED", 403),
    );
  }
  assert.equal(transactions, 0);
});

test("NDA admin reads exactly five columns and returns a PII-safe projection", async () => {
  const handler = createNdaAdminFetchHandler();
  let observedQuery;
  const response = await handler({
    actor: ADMIN,
    request: request({ highlightUserId: "legacy_user_123" }),
    database: {
      transaction: async (work) =>
        work({
          query: async (text, values) => {
            observedQuery = { text: String(text), values };
            return {
              rows: [
                {
                  source_id: "raw-record-uuid-never-returned",
                  signed_at: new Date("2026-08-22T00:00:00.000Z"),
                  nda_version: "v1.0",
                  pdf_available: true,
                  highlighted: true,
                  signer_email: "must-not-return@example.test",
                  signer_ip: "192.0.2.5",
                  pdf_url: "https://must-not-return.example.test/file.pdf",
                  user_id: "legacy_user_123",
                },
              ],
            };
          },
        }),
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, {
    "content-type": "application/json",
    "cache-control": "private, no-store",
  });
  assert.deepEqual(observedQuery.values, ["legacy_user_123"]);
  for (const column of ["id", "user_id", "signed_at", "nda_version", "pdf_url"]) {
    assert.match(observedQuery.text, new RegExp(`\\b${column}\\b`));
  }
  for (const forbidden of ["signer_name", "signer_email", "signer_ip"]) {
    assert.doesNotMatch(observedQuery.text, new RegExp(`\\b${forbidden}\\b`));
  }
  assert.match(response.body.records[0].record_id, /^nda_[a-f0-9]{20}$/);
  assert.equal(response.body.records[0].signed_at, "2026-08-22T00:00:00.000Z");
  assert.equal(response.body.records[0].pdf_available, true);
  assert.equal(response.body.records[0].highlighted, true);
  assert.equal(response.body.count, 1);
  const serialized = JSON.stringify(response.body);
  for (const forbidden of [
    "raw-record-uuid-never-returned",
    "must-not-return@example.test",
    "192.0.2.5",
    "https://must-not-return.example.test/file.pdf",
    "legacy_user_123",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("NDA admin rejects password compatibility and malformed highlight bodies", async () => {
  const handler = createNdaAdminFetchHandler();
  const database = { transaction: async () => [] };
  for (const body of [
    { password: "123456" },
    [],
    "body",
    { highlightUserId: "" },
    { highlightUserId: "line\nbreak" },
    { highlightUserId: "x".repeat(129) },
  ]) {
    await assert.rejects(
      handler({ actor: ADMIN, request: request(body), database }),
      (error) => runtimeCode(error, "INVALID_REQUEST", 400),
    );
  }
});

test("NDA admin fails closed on malformed database rows", async () => {
  const handler = createNdaAdminFetchHandler();
  await assert.rejects(
    handler({
      actor: ADMIN,
      request: request(),
      database: {
        transaction: async (work) =>
          work({
            query: async () => ({
              rows: [{ source_id: "id", signed_at: "invalid" }],
            }),
          }),
      },
    }),
    (error) => runtimeCode(error, "DATABASE_RESPONSE_INVALID", 503),
  );
});

test("engagement runtime wires only the private NDA handler and requires Cloud SQL", () => {
  const runtime = createRuntimeHandlers({
    config: {
      serviceOwner: "engagement-api-worker",
      publicStockQuotesEnabled: false,
    },
    fetchImpl: async () => {
      throw new Error("No provider fetch expected.");
    },
  });
  assert.deepEqual(Object.keys(runtime.handlers), ["nda-admin-fetch"]);
  assert.equal(runtime.databaseRequired, true);
  assert.equal(typeof runtime.handlers["nda-admin-fetch"], "function");
  assert.equal(FUNCTION_CONTRACTS["nda-admin-fetch"].maxRequestBytes, 4_096);
  assert.deepEqual(FUNCTION_CONTRACTS["nda-admin-fetch"].methods, ["POST"]);
});
