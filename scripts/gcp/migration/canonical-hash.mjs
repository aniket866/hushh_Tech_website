import { createHash } from "node:crypto";

import {
  MigrationContractError,
  assertSqlIdentifier,
  isAllowlistedPublicTable,
} from "./contract.mjs";

function canonicalize(value, path) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MigrationContractError(
        "NON_CANONICAL_VALUE",
        `${path} contains a non-finite number.`
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MigrationContractError(
        "NON_CANONICAL_VALUE",
        `${path} must contain JSON-compatible plain objects only.`
      );
    }
    const result = {};
    const normalizedKeys = new Set();
    const keys = Object.keys(value)
      .map((originalKey) => ({ originalKey, normalizedKey: originalKey.normalize("NFC") }))
      .sort((left, right) =>
        left.normalizedKey < right.normalizedKey
          ? -1
          : left.normalizedKey > right.normalizedKey
            ? 1
            : 0
      );
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new MigrationContractError(
        "NON_CANONICAL_VALUE",
        `${path} contains symbol keys, which are not JSON-compatible.`
      );
    }
    for (const { originalKey: key, normalizedKey } of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new MigrationContractError(
          "NON_CANONICAL_VALUE",
          `${path} contains a prohibited object key.`
        );
      }
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        throw new MigrationContractError(
          "NON_CANONICAL_VALUE",
          `${path}.${key} is not JSON-compatible.`
        );
      }
      if (normalizedKeys.has(normalizedKey)) {
        throw new MigrationContractError(
          "NON_CANONICAL_VALUE",
          `${path} contains object keys that collide after Unicode normalization.`
        );
      }
      normalizedKeys.add(normalizedKey);
      result[normalizedKey] = canonicalize(entry, `${path}.${key}`);
    }
    return result;
  }
  throw new MigrationContractError(
    "NON_CANONICAL_VALUE",
    `${path} is not JSON-compatible.`
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, "value"));
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalRowHash({ schema = "public", table, primaryKey, row }) {
  if (schema !== "public") {
    throw new MigrationContractError("SCHEMA_NOT_ALLOWED", "Only the public schema is allowed.");
  }
  assertSqlIdentifier(table, "table");
  if (!isAllowlistedPublicTable(table)) {
    throw new MigrationContractError("TABLE_NOT_ALLOWED", `${table} is outside the 70-table allowlist.`);
  }
  if (!primaryKey || typeof primaryKey !== "object" || Array.isArray(primaryKey)) {
    throw new MigrationContractError(
      "PRIMARY_KEY_REQUIRED",
      "A named primary-key object is required for canonical row hashing."
    );
  }
  if (Object.keys(primaryKey).length === 0) {
    throw new MigrationContractError(
      "PRIMARY_KEY_REQUIRED",
      "At least one primary-key field is required for canonical row hashing."
    );
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new MigrationContractError("ROW_REQUIRED", "A row object is required.");
  }
  for (const [key, value] of Object.entries(primaryKey)) {
    if (!(key in row) || canonicalJson(row[key]) !== canonicalJson(value)) {
      throw new MigrationContractError(
        "PRIMARY_KEY_MISMATCH",
        "The primary-key values must match the hashed row."
      );
    }
  }
  return canonicalHash({ schema, table, primaryKey, row });
}
