#!/usr/bin/env node

import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-hash.mjs";
import { buildPinnedUatExecutionLedger } from "./validate-uat-execution-ledger.mjs";

function main() {
  const outputArgument = process.argv[2];
  if (!isAbsolute(outputArgument ?? "")) throw new Error("EXECUTION_LEDGER_OUTPUT_PATH_INVALID");
  const output = resolve(outputArgument);
  const ledger = buildPinnedUatExecutionLedger();
  const descriptor = openSync(output, "wx", 0o644);
  try {
    writeFileSync(descriptor, `${canonicalJson(ledger)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", output, ledgerSha256: ledger.ledgerSha256, operationCount: ledger.cloudSqlOperations.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const blocker = /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "EXECUTION_LEDGER_BUILD_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker })}\n`);
    process.exitCode = 1;
  }
}
