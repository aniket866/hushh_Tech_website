import { readFileSync } from "node:fs";

import { canonicalHash, sha256 } from "./canonical.js";
import {
  COLLECTIONS,
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_QUERY_SET_SHA256,
} from "./constants.js";
import { AttestorError } from "./errors.js";

export const BEGIN_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;";
export const SESSION_SQL = Object.freeze([
  "SET LOCAL statement_timeout = '10s';",
  "SET LOCAL lock_timeout = '1s';",
  "SET LOCAL idle_in_transaction_session_timeout = '15s';",
  "SET LOCAL search_path = pg_catalog;",
  "SET LOCAL work_mem = '4MB';",
]);
export const ROLLBACK_SQL = "ROLLBACK;";

const BOUNDS_QUERY_URL = new URL("../sql/catalog-bounds.v1.sql", import.meta.url);
const CATALOG_QUERY_URL = new URL("../sql/catalog-attestation.v1.sql", import.meta.url);
const MUTATION_PATTERN = /\b(?:INSERT|UPDATE|DELETE|MERGE|COPY|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|CALL|DO)\b/i;

function querySetPayload(boundsSql, catalogSql) {
  return {
    begin: BEGIN_SQL,
    session: SESSION_SQL,
    bounds: boundsSql,
    catalog: catalogSql,
    rollback: ROLLBACK_SQL,
  };
}

export function loadAndValidateQueryContract({ boundsSql, catalogSql } = {}) {
  const bounds = boundsSql ?? readFileSync(BOUNDS_QUERY_URL, "utf8");
  const query = catalogSql ?? readFileSync(CATALOG_QUERY_URL, "utf8");
  const boundsQuerySha256 = sha256(Buffer.from(bounds, "utf8"));
  const catalogQuerySha256 = sha256(Buffer.from(query, "utf8"));
  const querySetSha256 = canonicalHash(querySetPayload(bounds, query));
  const boundsSemicolons = bounds.match(/;/g)?.length ?? 0;
  const semicolons = query.match(/;/g)?.length ?? 0;
  const structuralBounds = bounds.replace(/'(?:''|[^'])*'/gs, "''");
  const structuralQuery = query.replace(/'(?:''|[^'])*'/gs, "''");
  const boundedCollections = [...bounds.matchAll(/'([a-z_]+)'::text AS collection|\n\s*'([a-z_]+)',\n\s*count\(\*\)::bigint/g)].map(
    (match) => match[1] ?? match[2],
  );
  const emittedCollections = [...query.matchAll(/'([a-z_]+)'::text AS collection|\n\s*'([a-z_]+)',\n\s*count\(\*\)::bigint/g)].map(
    (match) => match[1] ?? match[2],
  );

  if (
    boundsQuerySha256 !== EXPECTED_BOUNDS_QUERY_SHA256 ||
    catalogQuerySha256 !== EXPECTED_CATALOG_QUERY_SHA256 ||
    querySetSha256 !== EXPECTED_QUERY_SET_SHA256 ||
    boundsSemicolons !== 1 ||
    semicolons !== 1 ||
    !bounds.trimEnd().endsWith(";") ||
    !query.trimEnd().endsWith(";") ||
    MUTATION_PATTERN.test(structuralBounds) ||
    MUTATION_PATTERN.test(structuralQuery) ||
    boundedCollections.length !== COLLECTIONS.length ||
    boundedCollections.some((name, index) => name !== COLLECTIONS[index]) ||
    emittedCollections.length !== COLLECTIONS.length ||
    emittedCollections.some((name, index) => name !== COLLECTIONS[index])
  ) {
    throw new AttestorError("QUERY_CONTRACT_DRIFT");
  }

  return Object.freeze({
    begin: BEGIN_SQL,
    session: SESSION_SQL,
    bounds,
    catalog: query,
    rollback: ROLLBACK_SQL,
    boundsQuerySha256,
    catalogQuerySha256,
    querySetSha256,
    statementCount: SESSION_SQL.length + 4,
  });
}
