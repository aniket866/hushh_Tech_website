#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

export const PREFLIGHT_IMAGE_MODULE_PATHS = Object.freeze([
  "/app/check-storage-preflight-image-closure.mjs",
  "/app/storage-cutover-contract.mjs",
  "/app/storage-isolated-cutover-contract.mjs",
  "/app/storage-live-common.mjs",
  "/app/storage-live-inventory.mjs",
  "/app/storage-live-policy.mjs",
  "/app/storage-preflight-job.mjs",
  "/app/storage-seven-bucket-contract.mjs",
]);

export const PREFLIGHT_IMAGE_DATA_PATHS = Object.freeze([
  "/migration/storage/supabase-storage-copy-policy.candidate.v1.json",
  "/migration/storage/supabase-storage-cutover.v1.json",
  "/migration/storage/supabase-storage-isolated-cutover-uat.v1.json",
  "/migration/storage/supabase-storage-seven-bucket-uat.activation.v1.json",
  "/migration/storage/supabase-storage-seven-bucket-uat.v1.json",
]);

export const PREFLIGHT_IMAGE_REQUIRED_PATHS = Object.freeze([
  ...PREFLIGHT_IMAGE_MODULE_PATHS,
  ...PREFLIGHT_IMAGE_DATA_PATHS,
]);

const underRoot = (root, imagePath) => join(resolve(root), imagePath.slice(1));

export const validatePreflightImageClosure = (root = "/") => {
  const required = new Set(PREFLIGHT_IMAGE_REQUIRED_PATHS.map(normalize));
  for (const imagePath of required) {
    const path = underRoot(root, imagePath);
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o222) !== 0) {
      throw new Error(`PREFLIGHT_IMAGE_FILE_NOT_IMMUTABLE:${imagePath}`);
    }
    readFileSync(path);
  }
  const relativeImportPattern = /(?:from\s+|import\s*)["'](\.[^"']+)["']/g;
  for (const imagePath of PREFLIGHT_IMAGE_MODULE_PATHS) {
    const source = readFileSync(underRoot(root, imagePath), "utf8");
    for (const match of source.matchAll(relativeImportPattern)) {
      const dependency = normalize(resolve(dirname(imagePath), match[1]));
      if (!required.has(dependency)) {
        throw new Error(`PREFLIGHT_IMAGE_IMPORT_OUTSIDE_CLOSURE:${imagePath}:${dependency}`);
      }
    }
  }
  const appEntries = readdirSync(underRoot(root, "/app"));
  if (appEntries.some((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))) {
    throw new Error("PREFLIGHT_IMAGE_PRIVATE_INPUT_EMBEDDED");
  }
  return { requiredFileCount: required.size };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? "/" : process.argv[rootIndex + 1];
  try {
    const result = validatePreflightImageClosure(root);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.message })}\n`);
    process.exitCode = 1;
  }
}
