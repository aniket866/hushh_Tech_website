#!/usr/bin/env node

import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-hash.mjs";
import {
  RETAINED_UAT_SOURCE_MANIFEST_SHA256,
  validateRowsForTable,
  validateSourceCaptureManifest,
} from "./uat-schema-data-executor.mjs";
import { buildUatSourceKeyManifest } from "./uat-source-key-manifest.mjs";

function parseArgs(argv) {
  const args = Object.fromEntries(argv.map((value) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(value);
    if (!match) throw new Error("SOURCE_KEY_ARGUMENT_INVALID");
    return [match[1], match[2]];
  }));
  for (const name of ["source-manifest", "row-directory", "output"]) {
    if (!isAbsolute(args[name] ?? "")) throw new Error("SOURCE_KEY_PATH_INVALID");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(resolve(args["source-manifest"]), "utf8"));
  const sourceManifest = input.sourceManifest ?? input;
  validateSourceCaptureManifest(sourceManifest, RETAINED_UAT_SOURCE_MANIFEST_SHA256);
  const rowsByTable = new Map();
  for (const table of sourceManifest.tables) {
    const rows = JSON.parse(readFileSync(resolve(args["row-directory"], table.artifact.member), "utf8"));
    validateRowsForTable(table, rows);
    rowsByTable.set(table.name, rows);
  }
  const manifest = buildUatSourceKeyManifest({ sourceManifest, rowsByTable });
  const output = resolve(args.output);
  const descriptor = openSync(output, "wx", 0o644);
  try {
    writeFileSync(descriptor, `${canonicalJson(manifest)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", output, tableCount: manifest.tableCount, rowCount: manifest.rowCount, manifestSha256: manifest.manifestSha256 })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const blocker = /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "SOURCE_KEY_BUILD_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker })}\n`);
    process.exitCode = 1;
  }
}
