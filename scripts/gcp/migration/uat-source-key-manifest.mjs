import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import { PUBLIC_TABLES } from "./contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;

export const RETAINED_UAT_SOURCE_KEY_MANIFEST_SHA256 =
  "050e24baa2b939ce539c7472502dd7d13bbdde0f8832712c4a6cd4229ae0cf70";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected, code) {
  if (canonicalHash(Object.keys(value ?? {}).sort()) !== canonicalHash([...expected].sort())) fail(code);
}

export function hashPrimaryKeys(table, rows) {
  if (!Array.isArray(table?.primaryKey) || table.primaryKey.length === 0 || !Array.isArray(rows)) {
    fail("SOURCE_KEY_INPUT_INVALID");
  }
  const seen = new Set();
  const canonicalKeys = [];
  for (const row of rows) {
    const key = Object.fromEntries(table.primaryKey.map((column) => [column, row?.[column]]));
    if (Object.values(key).some((value) => value === null || value === undefined)) fail("SOURCE_ROW_KEY_INVALID");
    const serialized = canonicalJson(key);
    if (seen.has(serialized)) fail("SOURCE_ROW_KEY_DUPLICATE");
    seen.add(serialized);
    canonicalKeys.push(serialized);
  }
  const hash = createHash("sha256");
  for (const key of canonicalKeys.sort()) hash.update(key, "utf8").update("\n", "utf8");
  return hash.digest("hex");
}

export function buildUatSourceKeyManifest({ sourceManifest, rowsByTable }) {
  if (!(rowsByTable instanceof Map) || rowsByTable.size !== PUBLIC_TABLES.length) fail("SOURCE_KEY_ROWS_INVALID");
  const tables = sourceManifest.tables.map((table) => {
    const rows = rowsByTable.get(table.name);
    if (!Array.isArray(rows) || rows.length !== table.rowCount) fail("SOURCE_KEY_ROWS_INVALID");
    return Object.freeze({
      name: table.name,
      primaryKey: table.primaryKey,
      keyCount: rows.length,
      keySha256: hashPrimaryKeys(table, rows),
    });
  });
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_SOURCE_PRIMARY_KEY_PARITY",
    sourceManifestSha256: sourceManifest.manifestSha256,
    bundleObjectSha256: sourceManifest.bundle.objectSha256,
    bundleGeneration: String(sourceManifest.bundle.generation),
    tableCount: tables.length,
    rowCount: tables.reduce((total, table) => total + table.keyCount, 0),
    tables,
  };
  return Object.freeze({ ...payload, manifestSha256: canonicalHash(payload) });
}

export function validateUatSourceKeyManifest(
  manifest,
  sourceManifest,
  expectedManifestSha256 = RETAINED_UAT_SOURCE_KEY_MANIFEST_SHA256,
  expectedRowCount = 45_042,
) {
  if (
    manifest?.version !== 1 ||
    manifest?.kind !== "HUSHH_TECH_UAT_SOURCE_PRIMARY_KEY_PARITY" ||
    manifest?.sourceManifestSha256 !== sourceManifest?.manifestSha256 ||
    manifest?.bundleObjectSha256 !== sourceManifest?.bundle?.objectSha256 ||
    String(manifest?.bundleGeneration) !== String(sourceManifest?.bundle?.generation) ||
    manifest?.tableCount !== 70 ||
    manifest?.rowCount !== expectedRowCount ||
    !Array.isArray(manifest?.tables) ||
    manifest.tables.length !== 70 ||
    !SHA256.test(manifest?.manifestSha256 ?? "") ||
    manifest.manifestSha256 !== expectedManifestSha256
  ) fail("SOURCE_KEY_MANIFEST_INVALID");
  exactKeys(manifest, ["version", "kind", "sourceManifestSha256", "bundleObjectSha256", "bundleGeneration", "tableCount", "rowCount", "tables", "manifestSha256"], "SOURCE_KEY_MANIFEST_INVALID");
  for (const [index, table] of manifest.tables.entries()) {
    const sourceTable = sourceManifest.tables[index];
    exactKeys(table, ["name", "primaryKey", "keyCount", "keySha256"], "SOURCE_KEY_TABLE_INVALID");
    if (
      table.name !== PUBLIC_TABLES[index] ||
      table.name !== sourceTable?.name ||
      canonicalHash(table.primaryKey) !== canonicalHash(sourceTable?.primaryKey) ||
      table.keyCount !== sourceTable?.rowCount ||
      !SHA256.test(table.keySha256 ?? "")
    ) fail("SOURCE_KEY_TABLE_INVALID");
  }
  if (manifest.tables.reduce((total, table) => total + table.keyCount, 0) !== manifest.rowCount) {
    fail("SOURCE_KEY_ROW_TOTAL_INVALID");
  }
  const { manifestSha256, ...payload } = manifest;
  if (canonicalHash(payload) !== manifestSha256) fail("SOURCE_KEY_MANIFEST_DIGEST_MISMATCH");
  return manifest;
}

export function loadRetainedUatSourceKeyManifest() {
  return JSON.parse(readFileSync(
    new URL("../../../migration/contracts/uat-source-key-manifest.v1.json", import.meta.url),
    "utf8",
  ));
}
