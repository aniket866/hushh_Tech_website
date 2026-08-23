import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash } from "./canonical-hash.mjs";
import {
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES,
  MigrationContractError,
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
  assertDryRunOnly,
  assertSafeForStdout,
  parseCliArgs,
  safeJsonForStdout,
} from "./contract.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const IDENTITY_FOUNDATION_PATH = fileURLToPath(
  new URL("../../../migration/sql/001_identity_migration_foundation.sql", import.meta.url)
);
const MAX_SCHEMA_DUMP_BYTES = 5 * 1024 * 1024;

export const TARGET_DATABASE_ROLES = Object.freeze({
  migration: "hushh_tech_migration",
  runtime: "hushh_tech_runtime",
  audit: "hushh_tech_audit",
  rollback: "hushh_tech_rollback",
});

export const TARGET_SCHEMA_OWNER_ROLE = "hushh_tech_schema_owner";

const TARGET_OPERATIONAL_ROLES = Object.freeze(Object.values(TARGET_DATABASE_ROLES));
const TARGET_BOUNDARY_ROLES = Object.freeze([
  TARGET_SCHEMA_OWNER_ROLE,
  ...TARGET_OPERATIONAL_ROLES,
]);
const TRUSTED_SECURITY_DEFINER_SEARCH_PATH =
  "pg_catalog, public, hushh_identity, pg_temp";
const TRUSTED_SECURITY_DEFINER_PROCONFIG =
  `search_path=${TRUSTED_SECURITY_DEFINER_SEARCH_PATH}`;

export const GENERIC_DELETE_FUNCTIONS = Object.freeze([
  "delete_rows_by_text_array_if_exists",
  "delete_rows_by_text_if_exists",
  "delete_rows_by_uuid_array_if_exists",
  "delete_rows_by_uuid_if_exists",
]);

export const TARGET_SCHEMA_PHASES = Object.freeze([
  "00_extension_and_role_preflight.sql.plan",
  "10_firebase_identity_context.sql.plan",
  "20_raw_parity_schema.sql.plan",
  "30_constraints_triggers_indexes.sql.plan",
  "40_firebase_rls_policies.sql.plan",
  "50_target_privileges.sql.plan",
  "60_catalog_validation.sql.plan",
]);

const PLAN_GUARD = `BEGIN;
DO $hushh_plan_only_execution$
BEGIN
  RAISE EXCEPTION 'PLAN_ONLY_EXECUTION: governed target executor is not present';
END
$hushh_plan_only_execution$;
`;

const SOURCE_ROLE_PATTERN = /\b(?:anon|authenticated|authenticator|service_role|supabase_admin)\b/i;
const SOURCE_AUTH_CALL_PATTERN = /\bauth\s*\.\s*(?:uid|jwt)\s*\(/i;
const SOURCE_AUTH_SCHEMA_PATTERN = /\bauth\s*\./i;
const SOURCE_STORAGE_SCHEMA_PATTERN = /\bstorage\s*\./i;
const SOURCE_EXTENSIONS_SCHEMA_PATTERN = /\bextensions\s*\./i;
const TRANSACTION_CONTROL_PATTERN = /^(?:ABORT|BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const AUTH_USERS_REFERENCE_PATTERN = /\bREFERENCES\s+(?:"auth"|auth)\s*\.\s*(?:"users"|users)\s*\(\s*(?:"id"|id)\s*\)/gi;
const SECRET_SHAPED_PATTERN = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:eyJ|sk[_-]|sb_secret_)[A-Za-z0-9._-]{12,}\b/,
];
const COMPILED_PLAN_RUNS = new WeakMap();

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) freezeDeep(entry);
  return Object.freeze(value);
}

function cloneJsonEvidence(value) {
  try {
    return freezeDeep(JSON.parse(JSON.stringify(value)));
  } catch {
    fail("INVALID_SCHEMA_CONTRACT", "Compiler evidence must be canonical JSON data.");
  }
}

function reportEnvelopeWithoutDigest(report) {
  const { planSha256: _planSha256, ...envelope } = report;
  return envelope;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isInsideRepository(path) {
  const pathRelativeToRepository = relative(REPOSITORY_ROOT, path);
  return (
    pathRelativeToRepository === "" ||
    (!pathRelativeToRepository.startsWith(`..${sep}`) && pathRelativeToRepository !== "..")
  );
}

function countNewlines(bytes) {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  return count;
}

function assertSafePrivateParent(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    fail("PRIVATE_PARENT_MODE_REQUIRED", "The private artifact parent must be a directory.");
  }
  const writableByOthers = (stats.mode & 0o022) !== 0;
  const sticky = (stats.mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) {
    fail(
      "PRIVATE_PARENT_MODE_REQUIRED",
      "The private artifact parent must not be group/world writable unless it is sticky."
    );
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SCHEMA_CONTRACT", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join(",") !== expected.join(",")) {
    fail("INVALID_SCHEMA_CONTRACT", `${label} contains unexpected or missing fields.`);
  }
}

function assertPrivateInputFile(path) {
  if (!isAbsolute(path)) {
    fail("PRIVATE_PATH_REQUIRED", "The schema dump path must be absolute.");
  }
  let directStats;
  try {
    directStats = lstatSync(path);
  } catch {
    fail("PRIVATE_FILE_UNAVAILABLE", "The decrypted schema dump could not be opened.");
  }
  if (directStats.isSymbolicLink() || !directStats.isFile()) {
    fail("PRIVATE_PATH_REQUIRED", "The schema dump must be a regular non-symlink file.");
  }
  let realPath;
  try {
    realPath = realpathSync(path);
  } catch {
    fail("PRIVATE_FILE_UNAVAILABLE", "The decrypted schema dump could not be resolved.");
  }
  if (isInsideRepository(realPath)) {
    fail("REPOSITORY_PLAINTEXT_FORBIDDEN", "The decrypted schema dump must stay outside the repository.");
  }
  const stats = statSync(realPath);
  if (stats.nlink !== 1) {
    fail("PRIVATE_FILE_LINK_COUNT", "The decrypted schema dump must have exactly one hard link.");
  }
  if ((stats.mode & 0o077) !== 0) {
    fail("PRIVATE_FILE_MODE_REQUIRED", "The decrypted schema dump must not be readable by group or others.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    fail("PRIVATE_FILE_OWNER_REQUIRED", "The decrypted schema dump must be owned by the current operator.");
  }
  if (stats.size <= 0 || stats.size > MAX_SCHEMA_DUMP_BYTES) {
    fail("SCHEMA_DUMP_SIZE_INVALID", "The decrypted schema dump has an invalid size.");
  }
  assertSafePrivateParent(realpathSync(dirname(realPath)));
  try {
    return { bytes: readFileSync(realPath), realPath };
  } catch {
    fail("PRIVATE_FILE_UNAVAILABLE", "The decrypted schema dump could not be read.");
  }
}

function assertPrivateOutputLocation(path) {
  if (!isAbsolute(path)) {
    fail("PRIVATE_PATH_REQUIRED", "The compiler output directory must be absolute.");
  }
  if (existsSync(path)) {
    fail("OUTPUT_ALREADY_EXISTS", "The compiler output directory must not already exist.");
  }
  let parent;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    fail("PRIVATE_OUTPUT_UNAVAILABLE", "The compiler output parent could not be resolved.");
  }
  assertSafePrivateParent(parent);
  const resolvedPath = resolve(parent, basename(path));
  if (isInsideRepository(resolvedPath)) {
    fail("REPOSITORY_PLAINTEXT_FORBIDDEN", "Compiled schema plans must stay outside the repository.");
  }
  return resolvedPath;
}

function stripAllowedPgDumpMetaCommands(text) {
  const lines = text.split("\n");
  const retained = [];
  for (const line of lines) {
    if (/^\\(?:restrict|unrestrict)\b/.test(line)) continue;
    if (/^\s*\\/.test(line)) {
      fail("PSQL_META_COMMAND_FORBIDDEN", "The schema dump contains an unreviewed psql meta-command.");
    }
    retained.push(line);
  }
  return retained.join("\n");
}

export function splitPostgresStatements(text) {
  if (typeof text !== "string" || text.length === 0 || text.includes("\u0000")) {
    fail("SCHEMA_DUMP_INVALID", "The decrypted schema dump must be non-empty UTF-8 SQL.");
  }
  const input = stripAllowedPgDumpMetaCommands(text);
  const statements = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = null;
  let singleQuoteBackslashEscapes = false;
  let doubleQuoteBackslashEscapes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += "\n";
      }
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (dollarTag) {
      if (input.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      continue;
    }
    if (singleQuoted) {
      current += char;
      if (singleQuoteBackslashEscapes && char === "\\" && next !== undefined) {
        current += next;
        index += 1;
      } else if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
        singleQuoteBackslashEscapes = false;
      }
      continue;
    }
    if (doubleQuoted) {
      current += char;
      if (doubleQuoteBackslashEscapes && char === "\\" && next !== undefined) {
        current += next;
        index += 1;
      } else if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
        doubleQuoteBackslashEscapes = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      singleQuoteBackslashEscapes = /(?:^|[^A-Za-z0-9_])(?:E|U&)$/i.test(current);
      current += char;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      doubleQuoteBackslashEscapes = /(?:^|[^A-Za-z0-9_])U&$/i.test(current);
      current += char;
      continue;
    }
    if (char === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(index));
      if (tagMatch) {
        dollarTag = tagMatch[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(`${statement};`);
      current = "";
      continue;
    }
    current += char;
  }

  if (singleQuoted || doubleQuoted || dollarTag || blockCommentDepth > 0) {
    fail("SCHEMA_DUMP_PARSE_ERROR", "The schema dump contains an unterminated quoted region.");
  }
  if (current.trim()) {
    fail("SCHEMA_DUMP_PARSE_ERROR", "Every schema statement must end with a semicolon.");
  }
  return statements;
}

function findBlockCommentEnd(text, openingIndex) {
  let depth = 1;
  for (let index = openingIndex + 2; index < text.length - 1; index += 1) {
    if (text[index] === "/" && text[index + 1] === "*") {
      depth += 1;
      index += 1;
    } else if (text[index] === "*" && text[index + 1] === "/") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    }
  }
  fail("SCHEMA_DUMP_PARSE_ERROR", "A block comment is unterminated.");
}

function structuralSql(statement) {
  let output = "";
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index];
    const next = statement[index + 1];
    if (char === "'") {
      const backslashEscapes = /(?:^|[^A-Za-z0-9_])(?:E|U&)$/i.test(output);
      output += " LITERAL ";
      for (index += 1; index < statement.length; index += 1) {
        if (backslashEscapes && statement[index] === "\\" && statement[index + 1] !== undefined) {
          index += 1;
        } else if (statement[index] === "'" && statement[index + 1] === "'") {
          index += 1;
        } else if (statement[index] === "'") {
          break;
        }
      }
      continue;
    }
    if (char === '"') {
      output += " IDENT ";
      for (index += 1; index < statement.length; index += 1) {
        if (statement[index] === '"' && statement[index + 1] === '"') {
          index += 1;
        } else if (statement[index] === '"') {
          break;
        }
      }
      continue;
    }
    if (char === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closing = statement.indexOf(tag, index + tag.length);
        if (closing < 0) fail("SCHEMA_DUMP_PARSE_ERROR", "A dollar-quoted region is unterminated.");
        output += " LITERAL ";
        index = closing + tag.length - 1;
        continue;
      }
    }
    if (char === "-" && next === "-") {
      while (index < statement.length && statement[index] !== "\n") index += 1;
      output += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const closing = findBlockCommentEnd(statement, index);
      output += " ";
      index = closing + 1;
      continue;
    }
    output += char;
  }
  return output.replace(/\s+/g, " ").trim();
}

const CANONICAL_SOURCE_IDENTIFIERS = new Set([
  "public",
  "auth",
  "uid",
  "jwt",
  "users",
  "id",
  "storage",
  "anon",
  "authenticated",
  "authenticator",
  "service_role",
  "supabase_admin",
  "search_path",
  "extensions",
  "uuid_generate_v4",
]);

function canonicalizeSourceIdentifiers(statement) {
  let output = "";
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index];
    const next = statement[index + 1];
    if (char === "'") {
      const start = index;
      const backslashEscapes = /(?:^|[^A-Za-z0-9_])(?:E|U&)$/i.test(output);
      for (index += 1; index < statement.length; index += 1) {
        if (backslashEscapes && statement[index] === "\\" && statement[index + 1] !== undefined) {
          index += 1;
        } else if (statement[index] === "'" && statement[index + 1] === "'") {
          index += 1;
        } else if (statement[index] === "'") {
          break;
        }
      }
      output += statement.slice(start, index + 1);
      continue;
    }
    if (char === '"') {
      const start = index;
      let identifier = "";
      for (index += 1; index < statement.length; index += 1) {
        if (statement[index] === '"' && statement[index + 1] === '"') {
          identifier += '"';
          index += 1;
        } else if (statement[index] === '"') {
          break;
        } else {
          identifier += statement[index];
        }
      }
      output += CANONICAL_SOURCE_IDENTIFIERS.has(identifier)
        ? identifier
        : statement.slice(start, index + 1);
      continue;
    }
    if (char === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closing = statement.indexOf(tag, index + tag.length);
        if (closing < 0) fail("SCHEMA_DUMP_PARSE_ERROR", "A dollar-quoted region is unterminated.");
        const body = statement.slice(index + tag.length, closing);
        output += `${tag}${canonicalizeSourceIdentifiers(body)}${tag}`;
        index = closing + tag.length - 1;
        continue;
      }
    }
    if (char === "-" && next === "-") {
      const start = index;
      while (index < statement.length && statement[index] !== "\n") index += 1;
      output += statement.slice(start, index + 1);
      continue;
    }
    if (char === "/" && next === "*") {
      const closing = findBlockCommentEnd(statement, index);
      output += statement.slice(index, closing + 2);
      index = closing + 1;
      continue;
    }
    output += char;
  }
  return output;
}

function rewriteExecutableSql(statement, rewritePlainText) {
  const canonical = canonicalizeSourceIdentifiers(statement);
  let output = "";
  let plain = "";
  const flushPlain = () => {
    if (plain) output += rewritePlainText(plain);
    plain = "";
  };
  for (let index = 0; index < canonical.length; index += 1) {
    const char = canonical[index];
    const next = canonical[index + 1];
    if (char === "'") {
      flushPlain();
      const start = index;
      const prefix = canonical.slice(Math.max(0, index - 2), index);
      const backslashEscapes = /(?:^|[^A-Za-z0-9_])(?:E|U&)$/i.test(prefix);
      for (index += 1; index < canonical.length; index += 1) {
        if (backslashEscapes && canonical[index] === "\\" && canonical[index + 1] !== undefined) {
          index += 1;
        } else if (canonical[index] === "'" && canonical[index + 1] === "'") {
          index += 1;
        } else if (canonical[index] === "'") {
          break;
        }
      }
      output += canonical.slice(start, index + 1);
      continue;
    }
    if (char === '"') {
      flushPlain();
      const start = index;
      for (index += 1; index < canonical.length; index += 1) {
        if (canonical[index] === '"' && canonical[index + 1] === '"') index += 1;
        else if (canonical[index] === '"') break;
      }
      output += canonical.slice(start, index + 1);
      continue;
    }
    if (char === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(canonical.slice(index));
      if (tagMatch) {
        flushPlain();
        const tag = tagMatch[0];
        const closing = canonical.indexOf(tag, index + tag.length);
        if (closing < 0) fail("SCHEMA_DUMP_PARSE_ERROR", "A dollar-quoted region is unterminated.");
        const body = canonical.slice(index + tag.length, closing);
        output += `${tag}${rewriteExecutableSql(body, rewritePlainText)}${tag}`;
        index = closing + tag.length - 1;
        continue;
      }
    }
    if (char === "-" && next === "-") {
      while (index < canonical.length && canonical[index] !== "\n") index += 1;
      plain += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const closing = findBlockCommentEnd(canonical, index);
      plain += " ";
      index = closing + 1;
      continue;
    }
    plain += char;
  }
  flushPlain();
  return output;
}

function executablePatternTest(statement, pattern) {
  let found = false;
  const flags = pattern.flags.replaceAll("g", "").replaceAll("y", "");
  const stablePattern = new RegExp(pattern.source, flags);
  rewriteExecutableSql(statement, (plain) => {
    if (stablePattern.test(plain)) found = true;
    return plain;
  });
  return found;
}

function transformSourceExtensionCalls(statement) {
  let translated = 0;
  const transformed = rewriteExecutableSql(statement, (plain) =>
    plain.replace(
      /\bextensions\s*\.\s*uuid_generate_v4\s*\(\s*\)/gi,
      () => {
        translated += 1;
        return "gen_random_uuid()";
      },
    ),
  );
  return { statement: transformed, translated };
}

function hasTopLevelComma(structure) {
  let depth = 0;
  for (const char of structure) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return true;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

function isReviewedAlterTableStructure(statement) {
  const match = /^ALTER\s+TABLE\s+(?:ONLY\s+)?public\.(?:"(?:""|[^"])+"|[a-z_][a-z0-9_]*)\s+([\s\S]+;)$/i.exec(
    statement
  );
  if (!match) return false;
  const action = structuralSql(match[1]);
  if (hasTopLevelComma(action)) return false;
  if (
    /\b(?:ADD\s+COLUMN|DROP|RENAME|ALTER\s+COLUMN|SET\s+SCHEMA|OWNER\s+TO|ENABLE\s+ROW|DISABLE\s+ROW|FORCE\s+ROW|NO\s+FORCE\s+ROW)\b/i.test(
      action
    )
  ) {
    return false;
  }
  const identifier = "(?:IDENT|[a-z_][a-z0-9_$]*)";
  return new RegExp(
    `^ADD CONSTRAINT ${identifier} (?:PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\\b[\\s\\S]*;$`,
    "i"
  ).test(action);
}

function unquoteIdentifier(value) {
  if (value.startsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
  return value;
}

function extractPublicTable(statement, prefix) {
  const pattern = new RegExp(
    `^${prefix}\\s+public\\.(\"(?:\"\"|[^\"])+\"|[a-z_][a-z0-9_]*)`,
    "i"
  );
  const match = pattern.exec(statement);
  return match ? unquoteIdentifier(match[1]) : null;
}

function extractCreatedTable(statement) {
  return extractPublicTable(
    statement,
    "CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?(?:\\s+ONLY)?"
  );
}

function extractFunctionName(statement) {
  const match = /^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)\s*\(/i.exec(
    statement
  );
  return match ? unquoteIdentifier(match[1]) : null;
}

function findMatchingParenthesis(text, openingIndex) {
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (singleQuoted) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') doubleQuoted = false;
      continue;
    }
    if (char === "'") singleQuoted = true;
    else if (char === '"') doubleQuoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail("FUNCTION_SIGNATURE_DRIFT", "A function argument list is not balanced.");
}

function splitTopLevelArguments(text) {
  if (!text.trim()) return [];
  const values = [];
  let current = "";
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (singleQuoted) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') doubleQuoted = false;
      continue;
    }
    if (char === "'") singleQuoted = true;
    else if (char === '"') doubleQuoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      values.push(current.trim());
      current = "";
    } else current += char;
  }
  values.push(current.trim());
  return values;
}

function normalizeIdentityArguments(text) {
  return splitTopLevelArguments(text)
    .map((argument) => normalizeSqlContractFragment(stripArgumentDefault(argument)))
    .join(", ");
}

function tokenizeSqlContractFragment(text) {
  const tokens = [];
  for (let index = 0; index < text.length; index += 1) {
    const start = index;
    const char = text[index];
    if (/\s/.test(char)) {
      while (/\s/.test(text[index + 1] ?? "")) index += 1;
      tokens.push({ kind: "space", raw: text.slice(start, index + 1), start });
      continue;
    }
    if (char === '"') {
      let value = "";
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '"' && text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (text[index] === '"') {
          break;
        } else {
          value += text[index];
        }
      }
      if (text[index] !== '"') {
        fail("FUNCTION_SIGNATURE_DRIFT", "A quoted function contract identifier is unterminated.");
      }
      tokens.push({
        kind: "identifier",
        quoted: true,
        raw: text.slice(start, index + 1),
        start,
        value,
      });
      continue;
    }
    if (char === "'") {
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "'" && text[index + 1] === "'") index += 1;
        else if (text[index] === "'") break;
      }
      if (text[index] !== "'") {
        fail("FUNCTION_SIGNATURE_DRIFT", "A function contract literal is unterminated.");
      }
      tokens.push({ kind: "literal", raw: text.slice(start, index + 1), start });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      while (/[A-Za-z0-9_$]/.test(text[index + 1] ?? "")) index += 1;
      const raw = text.slice(start, index + 1);
      tokens.push({ kind: "identifier", quoted: false, raw, start, value: raw });
      continue;
    }
    tokens.push({ kind: "punctuation", raw: char, start });
  }
  return tokens;
}

function stripArgumentDefault(argument) {
  const defaultToken = tokenizeSqlContractFragment(argument).find(
    (token) =>
      token.kind === "identifier" &&
      token.quoted === false &&
      token.value.toUpperCase() === "DEFAULT"
  );
  return defaultToken ? argument.slice(0, defaultToken.start) : argument;
}

function normalizeSqlContractFragment(text, { stripPublicSchema = false } = {}) {
  const tokens = tokenizeSqlContractFragment(text);
  const skipped = new Set();
  if (stripPublicSchema) {
    for (let index = 0; index < tokens.length; index += 1) {
      const schema = tokens[index];
      if (
        schema.kind !== "identifier" ||
        (schema.quoted ? schema.value !== "public" : schema.value.toLowerCase() !== "public")
      ) {
        continue;
      }
      let dotIndex = index + 1;
      while (tokens[dotIndex]?.kind === "space") dotIndex += 1;
      if (tokens[dotIndex]?.kind !== "punctuation" || tokens[dotIndex].raw !== ".") continue;
      let typeIndex = dotIndex + 1;
      while (tokens[typeIndex]?.kind === "space") typeIndex += 1;
      if (tokens[typeIndex]?.kind !== "identifier") continue;
      for (let skip = index; skip <= dotIndex; skip += 1) skipped.add(skip);
    }
  }
  return tokens
    .map((token, index) => {
      if (skipped.has(index)) return "";
      if (token.kind !== "identifier" || token.quoted === false) return token.raw;
      return /^[a-z_][a-z0-9_$]*$/.test(token.value) ? token.value : token.raw;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResultType(text) {
  return normalizeSqlContractFragment(text, { stripPublicSchema: true });
}

function splitDollarQuotedFunctionDefinition(statement) {
  let lastToken = null;
  let lastTokenStart = -1;

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index];
    const next = statement[index + 1];

    if (/\s/.test(char)) continue;
    if (char === "-") {
      if (next !== "-") {
        lastToken = char;
        lastTokenStart = index;
        continue;
      }
      while (index < statement.length && statement[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index = findBlockCommentEnd(statement, index) + 1;
      continue;
    }
    if (char === "'") {
      const prefix = statement.slice(Math.max(0, index - 2), index);
      const backslashEscapes = /(?:^|[^A-Za-z0-9_])(?:E|U&)$/i.test(prefix);
      for (index += 1; index < statement.length; index += 1) {
        if (backslashEscapes && statement[index] === "\\" && statement[index + 1] !== undefined) {
          index += 1;
        } else if (statement[index] === "'" && statement[index + 1] === "'") {
          index += 1;
        } else if (statement[index] === "'") {
          break;
        }
      }
      lastToken = "LITERAL";
      lastTokenStart = index;
      continue;
    }
    if (char === '"') {
      const start = index;
      for (index += 1; index < statement.length; index += 1) {
        if (statement[index] === '"' && statement[index + 1] === '"') index += 1;
        else if (statement[index] === '"') break;
      }
      lastToken = "IDENTIFIER";
      lastTokenStart = start;
      continue;
    }
    if (char === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closing = statement.indexOf(tag, index + tag.length);
        if (closing < 0) {
          fail("SCHEMA_DUMP_PARSE_ERROR", "A function body is unterminated.");
        }
        if (lastToken === "AS") {
          return {
            body: statement.slice(index + tag.length, closing),
            header: statement.slice(0, lastTokenStart),
            suffix: statement.slice(closing + tag.length),
            tag,
          };
        }
        index = closing + tag.length - 1;
        lastToken = "LITERAL";
        lastTokenStart = index;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (/[A-Za-z0-9_$]/.test(statement[index + 1] ?? "")) index += 1;
      lastToken = statement.slice(start, index + 1).toUpperCase();
      lastTokenStart = start;
      continue;
    }

    lastToken = char;
    lastTokenStart = index;
  }

  fail(
    "UNSAFE_SECURITY_DEFINER",
    "A function definition does not have a deterministic dollar-quoted body.",
  );
}

function functionHeaderStructure(statement) {
  return structuralSql(
    canonicalizeSourceIdentifiers(splitDollarQuotedFunctionDefinition(statement).header),
  );
}

function hasSecurityDefinerClause(statement) {
  return /\bSECURITY\s+DEFINER\b/i.test(functionHeaderStructure(statement));
}

function parseFunctionContract(statement, contract) {
  const name = extractFunctionName(statement);
  if (!name) fail("FUNCTION_SIGNATURE_DRIFT", "A public function header could not be parsed.");
  const nameMatch = /^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+public\.(?:"(?:""|[^"])+"|[a-z_][a-z0-9_]*)\s*/i.exec(
    statement
  );
  const openingIndex = statement.indexOf("(", nameMatch[0].length - 1);
  const closingIndex = findMatchingParenthesis(statement, openingIndex);
  const identityArguments = normalizeIdentityArguments(
    statement.slice(openingIndex + 1, closingIndex)
  );
  const returnMatch = /^\s*RETURNS\s+([^\n]+?)\s*(?:\n|\r\n?)\s*LANGUAGE\s+("(?:""|[^"])+"|[a-z_][a-z0-9_]*)(?=\s)/i.exec(
    statement.slice(closingIndex + 1)
  );
  if (!returnMatch) {
    fail("FUNCTION_SIGNATURE_DRIFT", "A frozen function return type or language could not be parsed.");
  }
  const result = normalizeResultType(returnMatch[1]);
  const quotedLanguage = returnMatch[2].startsWith('"');
  const languageToken = unquoteIdentifier(returnMatch[2]);
  const language = quotedLanguage ? languageToken : languageToken.toLowerCase();
  if (!new Set(["plpgsql", "sql"]).has(language)) {
    fail("FUNCTION_SIGNATURE_DRIFT", "A frozen function language is outside the reviewed set.");
  }
  const signature = `${name}(${identityArguments})->${result}`;
  const expectedSignature = contract.customPublicFunctionSignatures.find((entry) =>
    entry.startsWith(`${name}(`)
  );
  if (signature !== expectedSignature) {
    fail("FUNCTION_SIGNATURE_DRIFT", "A function signature differs from the frozen contract.");
  }
  const fact = contract.frozenSchemaFacts.functions.find(
    (entry) =>
      entry.function_name === name &&
      normalizeIdentityArguments(entry.identity_arguments) === identityArguments &&
      normalizeResultType(entry.result_type) === result
  );
  if (!fact) fail("FUNCTION_SIGNATURE_DRIFT", "Frozen function metadata is missing.");
  const headerStructure = functionHeaderStructure(statement);
  const securityDefiner = /\bSECURITY\s+DEFINER\b/i.test(headerStructure);
  const volatility = /\bIMMUTABLE\b/i.test(headerStructure)
    ? "i"
    : /\bSTABLE\b/i.test(headerStructure)
      ? "s"
      : "v";
  if (
    fact.security_definer !== securityDefiner ||
    fact.volatility !== volatility ||
    fact.prokind !== "f"
  ) {
    fail("FUNCTION_SECURITY_DRIFT", "Function security or volatility differs from frozen evidence.");
  }
  return {
    identityArguments,
    language,
    name,
    result,
    securityDefiner,
    signature,
  };
}

function extractPolicyKey(statement) {
  const match = /^CREATE\s+POLICY\s+("(?:""|[^"])+"|[a-z_][a-z0-9_]*)\s+ON\s+public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)(?=\s|;)/i.exec(
    statement
  );
  if (!match) return null;
  return `${unquoteIdentifier(match[2])}\u0000${unquoteIdentifier(match[1])}`;
}

function extractTriggerTable(statement) {
  const match = /^CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?\s+TRIGGER\b[\s\S]*?\sON\s+(?:ONLY\s+)?public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)(?=\s|;)/i.exec(
    statement
  );
  return match ? unquoteIdentifier(match[1]) : null;
}

function extractIndexTable(statement) {
  const match = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\sON\s+(?:ONLY\s+)?public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)(?=\s|;)/i.exec(
    statement
  );
  return match ? unquoteIdentifier(match[1]) : null;
}

function assertAllowlistedTable(table, context, tableSet) {
  if (!table || !tableSet.has(table)) {
    fail("TABLE_DRIFT", `${context} references a table outside the exact 70-table contract.`);
  }
}

function transformLegacyPrincipalReferences(statement) {
  let count = 0;
  const transformed = rewriteExecutableSql(statement, (plain) =>
    plain.replace(AUTH_USERS_REFERENCE_PATTERN, () => {
      count += 1;
      return "REFERENCES hushh_identity.identity_links (legacy_user_uuid)";
    })
  );
  const withoutReviewedCalls = rewriteExecutableSql(transformed, (plain) =>
    plain.replace(/\bauth\s*\.\s*(?:uid|jwt)\s*\(/gi, "reviewed_auth_call(")
  );
  if (executablePatternTest(withoutReviewedCalls, SOURCE_AUTH_SCHEMA_PATTERN)) {
    fail("UNMAPPED_AUTH_DEPENDENCY", "A source auth relation remains after legacy-principal translation.");
  }
  return { count, statement: transformed };
}

function transformLegacyAuthCalls(statement) {
  if (executablePatternTest(statement, /\bauth\s*\.\s*jwt\s*\(/i)) {
    fail(
      "UNMAPPED_AUTH_DEPENDENCY",
      "auth.jwt() claims require an explicit API contract and are not translated into runtime SQL."
    );
  }
  const transformed = rewriteExecutableSql(
    statement,
    (plain) =>
      plain.replace(
        /\bauth\s*\.\s*uid\s*\(\s*\)/gi,
        "hushh_identity.current_legacy_user_uuid()"
      )
  );
  if (
    executablePatternTest(transformed, SOURCE_AUTH_CALL_PATTERN) ||
    executablePatternTest(transformed, SOURCE_AUTH_SCHEMA_PATTERN)
  ) {
    fail("UNMAPPED_AUTH_DEPENDENCY", "A source auth schema dependency remains after Firebase translation.");
  }
  return transformed;
}

function hardenSecurityDefiner(statement) {
  if (!hasSecurityDefinerClause(statement)) return statement;
  const definition = splitDollarQuotedFunctionDefinition(statement);
  const canonicalHeader = canonicalizeSourceIdentifiers(definition.header);
  const retainedHeaderLines = [];

  for (const line of canonicalHeader.split(/\r?\n/)) {
    const structure = structuralSql(line);
    if (/^SET\s+search_path\s*(?:=|TO)\s+\S[\s\S]*$/i.test(structure)) continue;
    retainedHeaderLines.push(line);
  }

  const retainedHeader = retainedHeaderLines.join("\n").trimEnd();
  if (/\bSET\b/i.test(structuralSql(retainedHeader))) {
    fail(
      "UNSAFE_SECURITY_DEFINER",
      "A SECURITY DEFINER function has an additional unreviewed configuration setting.",
    );
  }

  return `${retainedHeader}\nSET search_path TO ${TRUSTED_SECURITY_DEFINER_SEARCH_PATH}\nAS ${definition.tag}${definition.body}${definition.tag}${definition.suffix}`;
}

function assertTrustedSecurityDefinerConfiguration(statement, expectedSecurityDefiner) {
  const securityDefiner = hasSecurityDefinerClause(statement);
  if (securityDefiner !== expectedSecurityDefiner) {
    fail(
      "FUNCTION_SECURITY_DRIFT",
      "A retained function security mode differs from frozen evidence.",
    );
  }
  if (!securityDefiner) return;

  const header = structuralSql(
    canonicalizeSourceIdentifiers(splitDollarQuotedFunctionDefinition(statement).header),
  );
  const exactSetting = `SET search_path TO ${TRUSTED_SECURITY_DEFINER_SEARCH_PATH}`;
  if (
    !header.endsWith(exactSetting) ||
    (header.match(/\bSET\b/gi) ?? []).length !== 1
  ) {
    fail(
      "UNSAFE_SECURITY_DEFINER",
      "A SECURITY DEFINER function lacks the exact trusted search_path configuration.",
    );
  }
}

function normalizeIdentityFoundation(sql) {
  const withoutBoundary = sql
    .replace(/^\s*BEGIN\s*;/i, "")
    .replace(/COMMIT\s*;\s*$/i, "")
    .trim();
  const identityTableStart = withoutBoundary.indexOf(
    "CREATE TABLE IF NOT EXISTS hushh_identity.identity_links"
  );
  const identityTableEnd = withoutBoundary.indexOf(
    "CREATE UNIQUE INDEX IF NOT EXISTS identity_links_active_legacy_uidx"
  );
  if (identityTableStart < 0 || identityTableEnd <= identityTableStart) {
    fail("IDENTITY_FOUNDATION_GAP", "The canonical identity_links table is absent.");
  }
  const identityTableSql = withoutBoundary.slice(identityTableStart, identityTableEnd);
  for (const invariant of [
    "legacy_user_uuid uuid NOT NULL",
    "firebase_uid text",
    "UNCLAIMED_LEGACY_PRINCIPAL",
    "status = 'UNCLAIMED_LEGACY_PRINCIPAL' AND firebase_uid IS NULL",
  ]) {
    if (!identityTableSql.includes(invariant)) {
      fail("IDENTITY_FOUNDATION_GAP", "identity_links is missing a locked denial or provenance invariant.");
    }
  }
  const required = [
    "hushh_identity.identity_links",
    "identity_links_legacy_principal_uidx",
    "UNCLAIMED_LEGACY_PRINCIPAL",
    "ENABLE ROW LEVEL SECURITY",
    "FORCE ROW LEVEL SECURITY",
    "email_was_used boolean NOT NULL DEFAULT false",
  ];
  for (const invariant of required) {
    if (!withoutBoundary.includes(invariant)) {
      fail("IDENTITY_FOUNDATION_GAP", "The identity foundation is missing a locked denial or provenance invariant.");
    }
  }
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(withoutBoundary)) {
    fail("TRANSACTION_CONTROL_FORBIDDEN", "Embedded transaction control is not allowed in a compiled phase.");
  }
  return withoutBoundary;
}

function wrapPlanOnlyPhase(name, body) {
  const bodyStatements = splitPostgresStatements(body);
  if (bodyStatements.some((statement) => TRANSACTION_CONTROL_PATTERN.test(statement))) {
    fail("TRANSACTION_CONTROL_FORBIDDEN", `${name} contains embedded transaction control.`);
  }
  return `-- ${name}\n-- Private review artifact. Execution is disabled by the first transaction statement.\n${PLAN_GUARD}${body.trim()}\nROLLBACK;\n`;
}

function extensionAndRolePreflightSql() {
  const roles = TARGET_BOUNDARY_ROLES;
  return `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

DO $hushh_target_boundary$
DECLARE
  role_name text;
  role_record record;
BEGIN
  IF current_database() <> 'hushh_tech_app' THEN
    RAISE EXCEPTION 'unexpected target database';
  END IF;
  IF current_setting('server_version_num')::integer < 170000
     OR current_setting('server_version_num')::integer >= 180000 THEN
    RAISE EXCEPTION 'target schema requires PostgreSQL 17';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[${roles.map((role) => `'${role}'`).join(", ")}]
  LOOP
    SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls
      INTO role_record
      FROM pg_catalog.pg_roles
     WHERE rolname = role_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'required target role is absent';
    END IF;
    IF role_record.rolsuper OR role_record.rolcreaterole OR role_record.rolcreatedb
       OR role_record.rolreplication OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'target role has forbidden elevated attributes';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}'
       AND (role_record.rolcanlogin OR role_record.rolinherit) THEN
      RAISE EXCEPTION 'sealed schema-owner role must be NOLOGIN and NOINHERIT';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_roles inherited_role
       WHERE inherited_role.rolname <> role_name
         AND (
           inherited_role.rolsuper OR inherited_role.rolcreaterole
           OR inherited_role.rolcreatedb OR inherited_role.rolreplication
           OR inherited_role.rolbypassrls
         )
         AND pg_catalog.pg_has_role(role_name, inherited_role.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'target role can inherit or SET ROLE into an elevated role';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_roles peer_role
       WHERE peer_role.rolname = ANY (ARRAY[${roles.map((role) => `'${role}'`).join(", ")}])
         AND peer_role.rolname <> role_name
         AND pg_catalog.pg_has_role(role_name, peer_role.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'target roles must not inherit or SET ROLE into each other';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}' AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_roles inherited_role
       WHERE inherited_role.oid <> role_record.oid
         AND pg_catalog.pg_has_role(role_record.oid, inherited_role.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'sealed schema-owner role must not inherit or SET ROLE into any role';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}' AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members membership
       WHERE membership.roleid = role_record.oid
    ) THEN
      RAISE EXCEPTION 'sealed schema-owner role must have no member before governed executor review';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_database d
       WHERE d.datname = current_database() AND d.datdba = role_record.oid
    ) THEN
      RAISE EXCEPTION 'a target database role must not own the database';
    END IF;
    IF EXISTS (
      WITH protected_owners(owner_oid) AS (
        SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()
        UNION
        SELECT n.nspowner FROM pg_catalog.pg_namespace n
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT c.relowner FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT p.proowner FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT e.extowner FROM pg_catalog.pg_extension e
      )
      SELECT 1 FROM protected_owners owners
       WHERE role_name <> '${TARGET_SCHEMA_OWNER_ROLE}'
         AND (
           owners.owner_oid = role_record.oid
           OR pg_catalog.pg_has_role(role_record.oid, owners.owner_oid, 'MEMBER')
         )
    ) THEN
      RAISE EXCEPTION 'operational role owns or can SET ROLE into a protected object owner';
    END IF;
    IF role_name <> '${TARGET_SCHEMA_OWNER_ROLE}' AND (
      has_database_privilege(role_name, current_database(), 'CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace target_schema
         WHERE target_schema.nspname IN ('public', 'hushh_identity', 'hushh_migration')
           AND has_schema_privilege(role_name, target_schema.oid, 'CREATE')
      )
    ) THEN
      RAISE EXCEPTION 'operational role exceeds the no-DDL boundary';
    END IF;
  END LOOP;
END
$hushh_target_boundary$;`;
}

function firebaseIdentityContextSql() {
  return `CREATE OR REPLACE FUNCTION hushh_identity.current_firebase_uid()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO pg_catalog
AS $firebase_uid$
  SELECT NULLIF(current_setting('app.firebase_uid', true), '')
$firebase_uid$;

CREATE OR REPLACE FUNCTION hushh_identity.current_legacy_user_uuid()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ${TRUSTED_SECURITY_DEFINER_SEARCH_PATH}
AS $legacy_uuid$
  SELECT links.legacy_user_uuid
    FROM hushh_identity.identity_links AS links
   WHERE links.legacy_project = 'ibsisfnjxeowvdtvgzff'
     AND links.firebase_uid = hushh_identity.current_firebase_uid()
     AND links.status = 'ACTIVE'
   LIMIT 1
$legacy_uuid$;

ALTER SCHEMA hushh_identity OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};
ALTER SCHEMA hushh_migration OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};
ALTER FUNCTION hushh_identity.current_firebase_uid() OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};
ALTER FUNCTION hushh_identity.current_legacy_user_uuid() OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};
REVOKE ALL ON FUNCTION hushh_identity.current_firebase_uid() FROM PUBLIC;
REVOKE ALL ON FUNCTION hushh_identity.current_legacy_user_uuid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hushh_identity.current_firebase_uid() TO ${TARGET_DATABASE_ROLES.runtime};
GRANT EXECUTE ON FUNCTION hushh_identity.current_legacy_user_uuid() TO ${TARGET_DATABASE_ROLES.runtime};`;
}

function operationalMetadataSql() {
  const migrationTables = [
    "migration_runs",
    "identity_migration_dispositions",
    "migration_checkpoints",
    "migration_audit_events",
    "migration_outbox",
  ];
  const statements = [
    `ALTER SCHEMA public OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
    `ALTER TABLE hushh_identity.identity_links OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
    `REVOKE ALL ON TABLE hushh_identity.identity_links FROM ${TARGET_DATABASE_ROLES.runtime};`,
    "DROP POLICY IF EXISTS identity_links_owner_active_lookup ON hushh_identity.identity_links;",
    `CREATE POLICY identity_links_owner_active_lookup ON hushh_identity.identity_links FOR SELECT TO ${TARGET_SCHEMA_OWNER_ROLE} USING (legacy_project = 'ibsisfnjxeowvdtvgzff' AND status = 'ACTIVE' AND firebase_uid = NULLIF(current_setting('app.firebase_uid', true), ''));`,
    "DROP POLICY IF EXISTS identity_links_migration_all ON hushh_identity.identity_links;",
    `CREATE POLICY identity_links_migration_all ON hushh_identity.identity_links FOR ALL TO ${TARGET_DATABASE_ROLES.migration} USING (true) WITH CHECK (true);`,
    "DROP POLICY IF EXISTS identity_links_rollback_all ON hushh_identity.identity_links;",
    `CREATE POLICY identity_links_rollback_all ON hushh_identity.identity_links FOR ALL TO ${TARGET_DATABASE_ROLES.rollback} USING (true) WITH CHECK (true);`,
    "DROP POLICY IF EXISTS identity_links_audit_select ON hushh_identity.identity_links;",
    `CREATE POLICY identity_links_audit_select ON hushh_identity.identity_links FOR SELECT TO ${TARGET_DATABASE_ROLES.audit} USING (true);`,
  ];
  for (const table of migrationTables) {
    const target = `hushh_migration.${quoteIdentifier(table)}`;
    statements.push(`ALTER TABLE ${target} OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`);
    statements.push(`REVOKE ALL ON TABLE ${target} FROM ${TARGET_DATABASE_ROLES.runtime};`);
    statements.push(`DROP POLICY IF EXISTS ${quoteIdentifier(`${table}_migration_all`)} ON ${target};`);
    statements.push(
      `CREATE POLICY ${quoteIdentifier(`${table}_migration_all`)} ON ${target} FOR ALL TO ${TARGET_DATABASE_ROLES.migration} USING (true) WITH CHECK (true);`
    );
    statements.push(`DROP POLICY IF EXISTS ${quoteIdentifier(`${table}_rollback_all`)} ON ${target};`);
    statements.push(
      `CREATE POLICY ${quoteIdentifier(`${table}_rollback_all`)} ON ${target} FOR ALL TO ${TARGET_DATABASE_ROLES.rollback} USING (true) WITH CHECK (true);`
    );
    statements.push(`DROP POLICY IF EXISTS ${quoteIdentifier(`${table}_audit_select`)} ON ${target};`);
    statements.push(
      `CREATE POLICY ${quoteIdentifier(`${table}_audit_select`)} ON ${target} FOR SELECT TO ${TARGET_DATABASE_ROLES.audit} USING (true);`
    );
  }
  statements.push(
    `ALTER FUNCTION hushh_migration.reject_audit_mutation() OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`
  );
  statements.push(
    `ALTER SEQUENCE hushh_migration.migration_audit_events_id_seq OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`
  );
  statements.push("REVOKE ALL ON FUNCTION hushh_migration.reject_audit_mutation() FROM PUBLIC;");
  return statements.join("\n");
}

function translatedPolicyExpression(expression) {
  if (expression === null || expression === undefined) return null;
  if (typeof expression !== "string" || expression.includes("\u0000")) {
    fail("INVALID_POLICY_EVIDENCE", "A frozen policy expression is invalid.");
  }
  return transformLegacyAuthCalls(expression);
}

function buildFirebasePolicies(contract, tableSet) {
  const publicPolicies = contract.frozenSchemaFacts.policies.filter(
    (policy) => policy.schemaname === "public"
  );
  if (publicPolicies.length !== contract.expected.livePublicPolicies) {
    fail("POLICY_DRIFT", "Frozen public policy evidence does not contain exactly 118 entries.");
  }
  const sourceKeys = new Set();
  const translatedKeys = new Set();
  const blockedKeyHashes = [];
  const ownershipMappings = new Set(
    contract.firebasePolicyMapping.firebaseOwnershipPolicies.map((entry) => JSON.stringify(entry))
  );
  const blockedMappings = new Set(
    contract.firebasePolicyMapping.blockedPolicies.map((entry) => JSON.stringify(entry))
  );
  const statements = [];
  for (const policy of publicPolicies) {
    assertAllowlistedTable(policy.tablename, "Frozen policy", tableSet);
    const sourceKey = `${policy.tablename}\u0000${policy.policyname}`;
    const mappingKey = JSON.stringify([
      policy.tablename,
      policy.policyname,
      policy.cmd,
      policy.roles,
    ]);
    if (sourceKeys.has(sourceKey)) {
      fail("POLICY_DRIFT", "Frozen public policy evidence contains a duplicate.");
    }
    sourceKeys.add(sourceKey);
    const command = String(policy.cmd).toUpperCase();
    if (!new Set(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]).has(command)) {
      fail("POLICY_DRIFT", "Frozen public policy evidence contains an unsupported command.");
    }
    if (blockedMappings.has(mappingKey)) {
      blockedKeyHashes.push(sha256(Buffer.from(mappingKey, "utf8")));
      continue;
    }
    if (!ownershipMappings.has(mappingKey)) {
      fail("POLICY_MAPPING_GAP", "A source public policy has no explicit target disposition.");
    }
    if (
      /service_role/i.test(policy.roles) ||
      !/\bauth\s*\.\s*uid\s*\(/i.test(`${policy.qual ?? ""} ${policy.with_check ?? ""}`) ||
      /\bauth\s*\.\s*jwt\s*\(/i.test(`${policy.qual ?? ""} ${policy.with_check ?? ""}`)
    ) {
      fail("POLICY_MAPPING_GAP", "A runtime policy lacks explicit Firebase ownership proof.");
    }
    translatedKeys.add(sourceKey);
    const using = translatedPolicyExpression(policy.qual);
    const withCheck = translatedPolicyExpression(policy.with_check);
    statements.push(
      [
        `DROP POLICY IF EXISTS ${quoteIdentifier(policy.policyname)} ON public.${quoteIdentifier(policy.tablename)};`,
        `CREATE POLICY ${quoteIdentifier(policy.policyname)} ON public.${quoteIdentifier(policy.tablename)}`,
        `  AS ${policy.permissive === "RESTRICTIVE" ? "RESTRICTIVE" : "PERMISSIVE"}`,
        `  FOR ${command}`,
        `  TO ${TARGET_DATABASE_ROLES.runtime}`,
        using ? `  USING (${using})` : null,
        withCheck ? `  WITH CHECK (${withCheck})` : null,
        ";",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (
    translatedKeys.size !== contract.firebasePolicyMapping.expected.firebaseOwnershipPolicies ||
    blockedKeyHashes.length !== contract.firebasePolicyMapping.expected.blockedPolicies
  ) {
    fail("POLICY_MAPPING_GAP", "The explicit runtime policy disposition totals have drifted.");
  }
  return {
    blockedKeyHashes: blockedKeyHashes.sort(),
    sourceKeys,
    sql: statements.join("\n\n"),
    translatedKeys,
  };
}

function buildRlsSql(tables) {
  return tables
    .flatMap((table) => [
      `ALTER TABLE public.${quoteIdentifier(table)} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE public.${quoteIdentifier(table)} FORCE ROW LEVEL SECURITY;`,
    ])
    .join("\n");
}

function buildOperationalPublicPolicies(tables) {
  const statements = [];
  for (const table of tables) {
    const target = `public.${quoteIdentifier(table)}`;
    const mapping = [
      ["hushh_migration_all", "ALL", TARGET_DATABASE_ROLES.migration],
      ["hushh_rollback_all", "ALL", TARGET_DATABASE_ROLES.rollback],
      ["hushh_audit_select", "SELECT", TARGET_DATABASE_ROLES.audit],
    ];
    for (const [suffix, command, role] of mapping) {
      const policyName = quoteIdentifier(`_${suffix}`);
      statements.push(`DROP POLICY IF EXISTS ${policyName} ON ${target};`);
      statements.push(
        `CREATE POLICY ${policyName} ON ${target} FOR ${command} TO ${role} USING (true)${
          command === "ALL" ? " WITH CHECK (true)" : ""
        };`
      );
    }
  }
  return statements.join("\n");
}

function buildPrivilegesSql(contract) {
  const migrationTables = [
    "migration_runs",
    "identity_migration_dispositions",
    "migration_checkpoints",
    "migration_audit_events",
    "migration_outbox",
  ];
  const lines = [
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    "REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM PUBLIC;",
    `GRANT USAGE ON SCHEMA public, hushh_identity TO ${TARGET_DATABASE_ROLES.runtime};`,
    `GRANT USAGE ON SCHEMA public, hushh_identity TO ${TARGET_DATABASE_ROLES.audit};`,
    `GRANT USAGE ON SCHEMA public, hushh_identity, hushh_migration TO ${TARGET_DATABASE_ROLES.migration};`,
    `GRANT USAGE ON SCHEMA public, hushh_identity, hushh_migration TO ${TARGET_DATABASE_ROLES.rollback};`,
    `REVOKE ALL ON TABLE hushh_identity.identity_links FROM ${TARGET_DATABASE_ROLES.runtime};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hushh_identity.identity_links TO ${TARGET_DATABASE_ROLES.migration};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hushh_identity.identity_links TO ${TARGET_DATABASE_ROLES.rollback};`,
    `GRANT SELECT ON TABLE hushh_identity.identity_links TO ${TARGET_DATABASE_ROLES.audit};`,
  ];
  for (const table of contract.publicTables) {
    const target = `public.${quoteIdentifier(table)}`;
    lines.push(`REVOKE ALL ON TABLE ${target} FROM PUBLIC;`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.runtime};`);
    lines.push(`GRANT SELECT ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.audit};`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.migration};`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.rollback};`);
  }

  for (const table of migrationTables) {
    const target = `hushh_migration.${quoteIdentifier(table)}`;
    lines.push(`REVOKE ALL ON TABLE ${target} FROM PUBLIC;`);
    lines.push(`REVOKE ALL ON TABLE ${target} FROM ${TARGET_DATABASE_ROLES.runtime};`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.migration};`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.rollback};`);
    lines.push(`GRANT SELECT ON TABLE ${target} TO ${TARGET_DATABASE_ROLES.audit};`);
  }
  lines.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hushh_migration TO ${TARGET_DATABASE_ROLES.migration};`);
  lines.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hushh_migration TO ${TARGET_DATABASE_ROLES.rollback};`);
  lines.push(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA hushh_migration TO ${TARGET_DATABASE_ROLES.audit};`);

  for (const signature of contract.customPublicFunctionSignatures.filter((entry) =>
    entry.endsWith("->trigger")
  )) {
    const name = signature.slice(0, signature.indexOf("("));
    const argumentsText = functionIdentityArgumentTypes(signature);
    const functionRef = `public.${quoteIdentifier(name)}(${argumentsText})`;
    lines.push(`REVOKE ALL ON FUNCTION ${functionRef} FROM PUBLIC;`);
    lines.push(`REVOKE ALL ON FUNCTION ${functionRef} FROM ${TARGET_DATABASE_ROLES.runtime};`);
    lines.push(`REVOKE ALL ON FUNCTION ${functionRef} FROM ${TARGET_DATABASE_ROLES.audit};`);
    lines.push(`GRANT EXECUTE ON FUNCTION ${functionRef} TO ${TARGET_DATABASE_ROLES.migration};`);
  }
  for (const role of TARGET_OPERATIONAL_ROLES) {
    lines.push(`REVOKE CREATE ON DATABASE hushh_tech_app FROM ${role};`);
    lines.push(`REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM ${role};`);
    lines.push(`REVOKE CREATE ON SCHEMA public FROM ${role};`);
    lines.push(`REVOKE CREATE ON SCHEMA hushh_identity FROM ${role};`);
    lines.push(`REVOKE CREATE ON SCHEMA hushh_migration FROM ${role};`);
  }
  return lines.join("\n");
}

function functionIdentityArgumentTypes(signature) {
  const argumentsText = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  if (!argumentsText.trim()) return "";
  return argumentsText
    .split(",")
    .map((argument) => {
      const normalized = argument.trim().replace(/^(?:INOUT|IN|OUT|VARIADIC)\s+/i, "");
      const match = /^[a-z_][a-z0-9_]*\s+(.+)$/i.exec(normalized);
      if (!match) fail("INVALID_FUNCTION_SIGNATURE", "A frozen function argument cannot be normalized.");
      return match[1].trim();
    })
    .join(", ");
}

function buildCatalogValidationSql(contract) {
  const tableValues = contract.publicTables.map((table) => `('${table}')`).join(",\n    ");
  const tableNames = contract.publicTables.map((table) => `'${table}'`).join(", ");
  const triggerFunctionNameList = contract.customPublicFunctionSignatures
    .filter((signature) => signature.endsWith("->trigger"))
    .map((signature) => signature.slice(0, signature.indexOf("(")));
  const triggerFunctionNames = triggerFunctionNameList.map((name) => `'${name}'`).join(", ");
  const securityDefinerTriggerNameList = contract.frozenSchemaFacts.functions
    .filter(
      (fact) =>
        fact.result_type === "trigger" &&
        fact.security_definer === true &&
        triggerFunctionNameList.includes(fact.function_name),
    )
    .map((fact) => fact.function_name)
    .sort();
  const securityDefinerTriggerNames = securityDefinerTriggerNameList
    .map((name) => `'${name}'`)
    .join(", ");
  const rpcFunctionNames = contract.customPublicFunctionSignatures
    .filter((signature) => !signature.endsWith("->trigger"))
    .map((signature) => `'${signature.slice(0, signature.indexOf("("))}'`)
    .join(", ");
  const roles = TARGET_BOUNDARY_ROLES;
  const capture = contract.frozenSchemaCaptureHashes.counts;
  return `DO $target_schema_validation$
DECLARE
  actual_table_count integer;
  expected_table_count integer;
  forced_rls_count integer;
  identity_link_rls boolean;
  role_name text;
  role_record record;
BEGIN
  SELECT count(*) INTO actual_table_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
  IF actual_table_count <> ${contract.expected.publicTables} THEN
    RAISE EXCEPTION 'public schema contains missing or extra raw-parity tables';
  END IF;

  WITH expected(name) AS (VALUES
    ${tableValues}
  )
  SELECT count(*) INTO expected_table_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN expected e ON e.name = c.relname
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
  IF expected_table_count <> ${contract.expected.publicTables} THEN
    RAISE EXCEPTION 'target raw-parity table count mismatch';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN (${tableNames})
         AND a.attnum > 0 AND NOT a.attisdropped) <> ${capture.columns}
     OR (SELECT count(*)
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN (${tableNames})) <> ${capture.constraints}
     OR (SELECT count(*)
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN (${tableNames})) <> ${capture.indexes}
     OR (SELECT count(*)
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN (${tableNames})
            AND NOT t.tgisinternal) <> ${capture.triggers} THEN
    RAISE EXCEPTION 'target column, constraint, index, or trigger count mismatch';
  END IF;

  SELECT count(*) INTO forced_rls_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN (${contract.publicTables.map((table) => `'${table}'`).join(", ")})
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF forced_rls_count <> ${contract.expected.publicTables} THEN
    RAISE EXCEPTION 'target forced-RLS count mismatch';
  END IF;

  SELECT c.relrowsecurity AND c.relforcerowsecurity INTO identity_link_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'hushh_identity' AND c.relname = 'identity_links';
  IF identity_link_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'identity_links must enable and force row-level security';
  END IF;

  FOREACH role_name IN ARRAY ARRAY[${roles.map((role) => `'${role}'`).join(", ")}]
  LOOP
    SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls
      INTO role_record FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF NOT FOUND OR role_record.rolsuper OR role_record.rolcreaterole
       OR role_record.rolcreatedb OR role_record.rolreplication OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'target role is absent or elevated';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}'
       AND (role_record.rolcanlogin OR role_record.rolinherit) THEN
      RAISE EXCEPTION 'sealed schema-owner role must be NOLOGIN and NOINHERIT';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles inherited_role
       WHERE inherited_role.rolname <> role_name
         AND (inherited_role.rolsuper OR inherited_role.rolcreaterole
              OR inherited_role.rolcreatedb OR inherited_role.rolreplication
              OR inherited_role.rolbypassrls)
         AND pg_catalog.pg_has_role(role_name, inherited_role.oid, 'MEMBER')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles peer_role
       WHERE peer_role.rolname = ANY (ARRAY[${roles.map((role) => `'${role}'`).join(", ")}])
         AND peer_role.rolname <> role_name
         AND pg_catalog.pg_has_role(role_name, peer_role.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'target role has inherited or SET ROLE escalation';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}' AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles inherited_role
       WHERE inherited_role.oid <> role_record.oid
         AND pg_catalog.pg_has_role(role_record.oid, inherited_role.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'sealed schema-owner role must not inherit or SET ROLE into any role';
    END IF;
    IF role_name = '${TARGET_SCHEMA_OWNER_ROLE}' AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members membership
       WHERE membership.roleid = role_record.oid
    ) THEN
      RAISE EXCEPTION 'sealed schema-owner role must have no member before governed executor review';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_database d
       WHERE d.datname = current_database() AND d.datdba = role_record.oid
    ) OR EXISTS (
      WITH protected_owners(owner_oid) AS (
        SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = current_database()
        UNION
        SELECT n.nspowner FROM pg_catalog.pg_namespace n
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT c.relowner FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT p.proowner FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
        UNION
        SELECT e.extowner FROM pg_catalog.pg_extension e
      )
      SELECT 1 FROM protected_owners owners
       WHERE role_name <> '${TARGET_SCHEMA_OWNER_ROLE}'
         AND (
           owners.owner_oid = role_record.oid
           OR pg_catalog.pg_has_role(role_record.oid, owners.owner_oid, 'MEMBER')
         )
    ) THEN
      RAISE EXCEPTION 'operational role owns or can SET ROLE into a protected object owner';
    END IF;
    IF role_name <> '${TARGET_SCHEMA_OWNER_ROLE}' AND (
      has_database_privilege(role_name, current_database(), 'CREATE')
      OR has_database_privilege(role_name, current_database(), 'TEMPORARY')
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace target_schema
         WHERE target_schema.nspname IN ('public', 'hushh_identity', 'hushh_migration')
           AND has_schema_privilege(role_name, target_schema.oid, 'CREATE')
      )
    ) THEN
      RAISE EXCEPTION 'operational role exceeds the no-DDL or TEMP boundary';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
       AND n.nspowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_SCHEMA_OWNER_ROLE}')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (
       (n.nspname = 'public' AND c.relname IN (${tableNames}) AND c.relkind IN ('r', 'p'))
       OR (n.nspname IN ('hushh_identity', 'hushh_migration') AND c.relkind IN ('r', 'p', 'S'))
     )
       AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_SCHEMA_OWNER_ROLE}')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE (
       (n.nspname = 'public' AND p.proname IN (${triggerFunctionNames}))
       OR n.nspname IN ('hushh_identity', 'hushh_migration')
     )
       AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_SCHEMA_OWNER_ROLE}')
  ) OR (SELECT count(*) FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'hushh_identity' AND c.relkind IN ('r', 'p', 'S')
         AND c.relname IN ('identity_links')) <> 1
  OR (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'hushh_migration' AND c.relkind IN ('r', 'p', 'S')
       AND c.relname IN (
         'migration_runs', 'identity_migration_dispositions', 'migration_checkpoints',
         'migration_audit_events', 'migration_outbox', 'migration_audit_events_id_seq'
       )) <> 6
  OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('hushh_identity', 'hushh_migration')
       AND c.relkind IN ('r', 'p', 'S')
       AND c.relname NOT IN (
         'identity_links', 'migration_runs', 'identity_migration_dispositions',
         'migration_checkpoints', 'migration_audit_events', 'migration_outbox',
         'migration_audit_events_id_seq'
       )
  ) OR (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname = 'hushh_identity'
              AND p.proname IN ('current_firebase_uid', 'current_legacy_user_uuid'))
          OR (n.nspname = 'hushh_migration' AND p.proname = 'reject_audit_mutation')) <> 3
  OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('hushh_identity', 'hushh_migration')
       AND p.proname NOT IN ('current_firebase_uid', 'current_legacy_user_uuid', 'reject_audit_mutation')
  ) OR (SELECT count(*) FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'S') <> ${capture.sequences} THEN
    RAISE EXCEPTION 'exact expected schema, table, sequence, or function owner mapping mismatch';
  END IF;

  IF has_database_privilege('${TARGET_DATABASE_ROLES.runtime}', current_database(), 'CREATE')
     OR has_database_privilege('${TARGET_DATABASE_ROLES.runtime}', current_database(), 'TEMPORARY')
     OR has_schema_privilege('${TARGET_DATABASE_ROLES.runtime}', 'public', 'CREATE')
     OR has_schema_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_identity', 'CREATE')
     OR has_schema_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_migration', 'CREATE') THEN
    RAISE EXCEPTION 'runtime role exceeds DML-only boundary';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
       AND n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_DATABASE_ROLES.runtime}')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
       AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_DATABASE_ROLES.runtime}')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'hushh_identity', 'hushh_migration')
       AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = '${TARGET_DATABASE_ROLES.runtime}')
  ) THEN
    RAISE EXCEPTION 'runtime role owns a protected schema object';
  END IF;

  IF has_table_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_identity.identity_links', 'SELECT')
     OR has_table_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_identity.identity_links', 'INSERT')
     OR has_table_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_identity.identity_links', 'UPDATE')
     OR has_table_privilege('${TARGET_DATABASE_ROLES.runtime}', 'hushh_identity.identity_links', 'DELETE') THEN
    RAISE EXCEPTION 'runtime role has direct identity_links access';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public') <> 280
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND '${TARGET_DATABASE_ROLES.runtime}' = ANY (roles::text[])) <> 70
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND '${TARGET_DATABASE_ROLES.migration}' = ANY (roles::text[])) <> 70
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND '${TARGET_DATABASE_ROLES.rollback}' = ANY (roles::text[])) <> 70
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND '${TARGET_DATABASE_ROLES.audit}' = ANY (roles::text[])) <> 70
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                 WHERE schemaname IN ('public', 'hushh_identity', 'hushh_migration')
                   AND 'public' = ANY (roles::text[])) THEN
    RAISE EXCEPTION 'target row-level policy role set mismatch';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname IN ('hushh_identity', 'hushh_migration')) <> 19
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname IN ('hushh_identity', 'hushh_migration')
            AND '${TARGET_SCHEMA_OWNER_ROLE}' = ANY (roles::text[])) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname IN ('hushh_identity', 'hushh_migration')
            AND '${TARGET_DATABASE_ROLES.migration}' = ANY (roles::text[])) <> 6
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname IN ('hushh_identity', 'hushh_migration')
            AND '${TARGET_DATABASE_ROLES.rollback}' = ANY (roles::text[])) <> 6
     OR (SELECT count(*) FROM pg_catalog.pg_policies
          WHERE schemaname IN ('hushh_identity', 'hushh_migration')
            AND '${TARGET_DATABASE_ROLES.audit}' = ANY (roles::text[])) <> 6
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies
        WHERE schemaname = 'hushh_identity' AND tablename = 'identity_links'
          AND policyname = 'identity_links_owner_active_lookup' AND cmd = 'SELECT'
          AND roles::text[] = ARRAY['${TARGET_SCHEMA_OWNER_ROLE}']::text[]
     ) THEN
    RAISE EXCEPTION 'operational metadata policy set mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (${rpcFunctionNames})
  ) OR (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN (${triggerFunctionNames})) <> 8 THEN
    RAISE EXCEPTION 'legacy RPC or trigger-function disposition mismatch';
  END IF;

  IF (SELECT count(*)
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (${triggerFunctionNames})
         AND p.prosecdef) <> ${securityDefinerTriggerNameList.length}
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (${triggerFunctionNames})
          AND (
            (p.proname IN (${securityDefinerTriggerNames}) AND (
              NOT p.prosecdef
              OR p.proconfig IS DISTINCT FROM ARRAY['${TRUSTED_SECURITY_DEFINER_PROCONFIG}']::text[]
            ))
            OR (p.proname NOT IN (${securityDefinerTriggerNames}) AND p.prosecdef)
          )
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'hushh_identity'
          AND p.proname = 'current_legacy_user_uuid'
          AND (
            NOT p.prosecdef
            OR p.proconfig IS DISTINCT FROM ARRAY['${TRUSTED_SECURITY_DEFINER_PROCONFIG}']::text[]
          )
     ) THEN
    RAISE EXCEPTION 'security-definer search_path configuration mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (${triggerFunctionNames})
       AND has_function_privilege('${TARGET_DATABASE_ROLES.runtime}', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'runtime role can execute a retained legacy trigger function';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'hushh_identity' AND tablename = 'identity_links'
       AND indexname = 'identity_links_legacy_principal_uidx'
  ) OR EXISTS (
    SELECT 1 FROM unnest(ARRAY['pgcrypto', 'uuid-ossp', 'vector']) AS required_extension(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = required_extension.name
     )
  ) THEN
    RAISE EXCEPTION 'identity key or reviewed target extension is absent';
  END IF;
END
$target_schema_validation$;`;
}

function classifySourceStatements(statements, contract, dumpEvidence) {
  const tableSet = new Set(contract.publicTables);
  const expectedFunctions = new Set(contract.customPublicFunctionSignatures);
  const expectedTriggerFunctions = new Set(
    contract.customPublicFunctionSignatures.filter((signature) => signature.endsWith("->trigger"))
  );
  const expectedRpcFunctions = new Set(
    contract.customPublicFunctionSignatures.filter((signature) => !signature.endsWith("->trigger"))
  );
  const expectedPolicyKeys = new Set(
    contract.frozenSchemaFacts.policies
      .filter((policy) => policy.schemaname === "public")
      .map((policy) => `${policy.tablename}\u0000${policy.policyname}`)
  );
  const seenTables = new Set();
  const seenFunctions = new Set();
  const seenPolicies = new Set();
  const rawParity = [];
  const dependentObjects = [];
  const withheldRpcKeyHashes = [];
  let triggerCount = 0;
  let explicitIndexCount = 0;
  let crossSchemaAuthForeignKeysTranslated = 0;

  for (const sourceStatement of statements) {
    // pg_dump quotes canonical schemas and roles when --quote-all-identifiers is
    // active. Normalize only the reviewed identifier set before dispatching the
    // statement; literals, comments, and every application identifier stay
    // byte-for-byte quoted.
    const statement = canonicalizeSourceIdentifiers(sourceStatement);
    if (TRANSACTION_CONTROL_PATTERN.test(statement)) {
      fail("TRANSACTION_CONTROL_FORBIDDEN", "The source dump contains transaction control.");
    }
    if (/^(?:COPY|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|WITH)\b/i.test(statement)) {
      fail("SCHEMA_DUMP_CONTAINS_DATA", "The source artifact is not schema-only.");
    }
    if (/^(?:DO|CALL)\b/i.test(statement)) {
      fail("UNSUPPORTED_SOURCE_STATEMENT", "The source dump contains executable procedural SQL.");
    }
    if (/^CREATE\s+(?:DATABASE|ROLE|USER|SUBSCRIPTION)\b/i.test(statement)) {
      fail("UNSAFE_SOURCE_DDL", "The source dump contains target-boundary DDL.");
    }
    if (/^DROP\b/i.test(statement)) {
      fail("UNSAFE_SOURCE_DDL", "The source dump contains destructive target-boundary DDL.");
    }

    const table = extractCreatedTable(statement);
    if (table) {
      assertAllowlistedTable(table, "CREATE TABLE", tableSet);
      if (seenTables.has(table)) fail("TABLE_DRIFT", "The schema dump defines a table more than once.");
      seenTables.add(table);
      const normalizedCreateTable = statement.replace(
        /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
        "CREATE TABLE"
      );
      const principalTransform = transformLegacyPrincipalReferences(normalizedCreateTable);
      crossSchemaAuthForeignKeysTranslated += principalTransform.count;
      const authTransformed = transformLegacyAuthCalls(principalTransform.statement);
      const extensionTransform = transformSourceExtensionCalls(authTransformed);
      const transformed = extensionTransform.statement;
      if (
        executablePatternTest(transformed, SOURCE_STORAGE_SCHEMA_PATTERN) ||
        executablePatternTest(transformed, SOURCE_ROLE_PATTERN)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "A CREATE TABLE retains a source schema or database role.");
      }
      rawParity.push(
        `${transformed}\nALTER TABLE public.${quoteIdentifier(table)} OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`
      );
      continue;
    }
    if (/^CREATE\s+TABLE\b/i.test(statement)) {
      fail("TABLE_DRIFT", "The schema dump defines a table outside public schema.");
    }

    const functionName = extractFunctionName(statement);
    if (functionName) {
      const parsed = parseFunctionContract(statement, contract);
      if (!expectedFunctions.has(parsed.signature) || seenFunctions.has(parsed.signature)) {
        fail("FUNCTION_DRIFT", "The schema dump function set differs from the frozen 24-function set.");
      }
      seenFunctions.add(parsed.signature);
      if (expectedRpcFunctions.has(parsed.signature)) {
        withheldRpcKeyHashes.push(sha256(Buffer.from(parsed.signature, "utf8")));
        continue;
      }
      if (!expectedTriggerFunctions.has(parsed.signature)) {
        fail("FUNCTION_DRIFT", "A source function lacks a reviewed trigger-only disposition.");
      }
      if (executablePatternTest(statement, /\bEXECUTE\b/i)) {
        fail(
          "DYNAMIC_SQL_BLOCKED",
          "A retained function contains dynamic SQL that has not been fully parsed and reviewed.",
        );
      }
      const principalTransform = transformLegacyPrincipalReferences(statement);
      crossSchemaAuthForeignKeysTranslated += principalTransform.count;
      const transformed = hardenSecurityDefiner(transformLegacyAuthCalls(principalTransform.statement));
      if (executablePatternTest(transformed, SOURCE_ROLE_PATTERN)) {
        fail("SOURCE_ROLE_DEPENDENCY", "A source database role remains inside a function definition.");
      }
      const functionRef = `public.${quoteIdentifier(parsed.name)}(${functionIdentityArgumentTypes(parsed.signature)})`;
      dependentObjects.push(
        [
          transformed,
          `ALTER FUNCTION ${functionRef} OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
          `REVOKE ALL ON FUNCTION ${functionRef} FROM PUBLIC;`,
          ...TARGET_BOUNDARY_ROLES.map(
            (role) => `REVOKE ALL ON FUNCTION ${functionRef} FROM ${role};`
          ),
        ].join("\n")
      );
      continue;
    }
    if (/^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\b/i.test(statement)) {
      fail("FUNCTION_DRIFT", "The schema dump defines a function outside the frozen public set.");
    }

    const policyKey = extractPolicyKey(statement);
    if (policyKey) {
      if (!expectedPolicyKeys.has(policyKey) || seenPolicies.has(policyKey)) {
        fail("POLICY_DRIFT", "The schema dump policy set differs from frozen sanitized evidence.");
      }
      seenPolicies.add(policyKey);
      continue;
    }
    if (/^CREATE\s+POLICY\b/i.test(statement)) {
      fail("POLICY_DRIFT", "The schema dump defines a policy outside the frozen public set.");
    }

    const triggerTable = extractTriggerTable(statement);
    if (triggerTable) {
      assertAllowlistedTable(triggerTable, "CREATE TRIGGER", tableSet);
      const invokedFunction = /\bEXECUTE\s+FUNCTION\s+public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)\s*\(/i.exec(
        statement
      );
      if (!invokedFunction) {
        fail("TRIGGER_DRIFT", "A trigger does not invoke a frozen public trigger function.");
      }
      const invokedName = unquoteIdentifier(invokedFunction[1]);
      if (
        ![...expectedTriggerFunctions].some(
          (signature) => signature.startsWith(`${invokedName}(`)
        )
      ) {
        fail("TRIGGER_DRIFT", "A trigger invokes a function outside the frozen trigger set.");
      }
      triggerCount += 1;
      const normalizedTrigger = statement.replace(
        /^CREATE\s+OR\s+REPLACE(?=\s+(?:CONSTRAINT\s+)?TRIGGER\b)/i,
        "CREATE"
      );
      const transformed = transformLegacyAuthCalls(normalizedTrigger);
      if (
        executablePatternTest(transformed, SOURCE_STORAGE_SCHEMA_PATTERN) ||
        executablePatternTest(transformed, SOURCE_ROLE_PATTERN)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "A trigger retains a source schema or database role.");
      }
      dependentObjects.push(transformed);
      continue;
    }
    if (/^CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?\s+TRIGGER\b/i.test(statement)) {
      fail("TRIGGER_DRIFT", "The schema dump defines a trigger outside the frozen public set.");
    }

    const indexTable = extractIndexTable(statement);
    if (indexTable) {
      assertAllowlistedTable(indexTable, "CREATE INDEX", tableSet);
      const principalTransform = transformLegacyPrincipalReferences(statement);
      crossSchemaAuthForeignKeysTranslated += principalTransform.count;
      const transformed = transformLegacyAuthCalls(principalTransform.statement);
      if (
        executablePatternTest(transformed, SOURCE_STORAGE_SCHEMA_PATTERN) ||
        executablePatternTest(transformed, SOURCE_ROLE_PATTERN)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "An index retains a source schema or database role.");
      }
      explicitIndexCount += 1;
      dependentObjects.push(transformed);
      continue;
    }

    if (/^(?:GRANT|REVOKE|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i.test(statement)) continue;
    if (/^ALTER\b[\s\S]*\bOWNER\s+TO\b/i.test(statement)) continue;
    if (/^ALTER\s+TABLE\b[\s\S]*\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(statement)) continue;
    if (/^(?:CREATE|ALTER|DROP)\s+PUBLICATION\b/i.test(statement)) continue;
    if (/^(?:SET|RESET)\b/i.test(statement)) continue;
    if (/^SELECT\s+pg_catalog\.set_config\b/i.test(statement)) continue;
    if (/^CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?public\b/i.test(statement)) continue;
    if (/^ALTER\s+SCHEMA\s+public\b/i.test(statement)) continue;

    const extensionMatch = /^CREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+("(?:""|[^"])+"|[a-z_][a-z0-9_-]*)(?=\s|;)/i.exec(
      statement
    );
    if (extensionMatch) {
      const extension = unquoteIdentifier(extensionMatch[1]).toLowerCase();
      if (!new Set(["pgcrypto", "uuid-ossp", "vector"]).has(extension)) {
        fail("EXTENSION_DISPOSITION_REQUIRED", "A source extension has no reviewed target disposition.");
      }
      continue;
    }

    if (/^CREATE\s+(?:TYPE|DOMAIN)\s+public\./i.test(statement)) {
      const principalTransform = transformLegacyPrincipalReferences(statement);
      crossSchemaAuthForeignKeysTranslated += principalTransform.count;
      const transformed = transformLegacyAuthCalls(principalTransform.statement);
      if (
        executablePatternTest(transformed, SOURCE_STORAGE_SCHEMA_PATTERN) ||
        executablePatternTest(transformed, SOURCE_ROLE_PATTERN)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "A public type retains a source schema dependency.");
      }
      rawParity.push(transformed);
      continue;
    }

    if (/^COMMENT\s+ON\b/i.test(statement)) {
      if (
        !/\bpublic\./i.test(statement) &&
        !/^COMMENT\s+ON\s+(?:SCHEMA\s+public|EXTENSION\s+(?:pgcrypto|"uuid-ossp"|vector))/i.test(
          statement
        )
      ) {
        fail("UNSUPPORTED_SOURCE_STATEMENT", "A source comment is outside the reviewed public scope.");
      }
      const commentStructure = structuralSql(canonicalizeSourceIdentifiers(statement));
      if (
        SOURCE_AUTH_SCHEMA_PATTERN.test(commentStructure) ||
        SOURCE_STORAGE_SCHEMA_PATTERN.test(commentStructure)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "A source comment retains a source schema dependency.");
      }
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(statement)) {
      const alteredTable = extractPublicTable(statement, "ALTER\\s+TABLE(?:\\s+ONLY)?");
      assertAllowlistedTable(alteredTable, "ALTER TABLE", tableSet);
      if (!isReviewedAlterTableStructure(statement)) {
        fail("UNSUPPORTED_SOURCE_STATEMENT", "An ALTER TABLE form has no reviewed target disposition.");
      }
      const principalTransform = transformLegacyPrincipalReferences(statement);
      crossSchemaAuthForeignKeysTranslated += principalTransform.count;
      const transformed = transformLegacyAuthCalls(principalTransform.statement);
      if (
        executablePatternTest(transformed, SOURCE_STORAGE_SCHEMA_PATTERN) ||
        executablePatternTest(transformed, SOURCE_ROLE_PATTERN)
      ) {
        fail("SOURCE_SCHEMA_DEPENDENCY", "Dependent DDL retains a source schema or database role.");
      }
      dependentObjects.push(transformed);
      continue;
    }

    fail("UNSUPPORTED_SOURCE_STATEMENT", "The source dump contains an unsupported statement class.");
  }

  const dumpCounts = dumpEvidence.dump;
  const exactSet = (actual, expected) =>
    actual.size === expected.size && [...actual].every((entry) => expected.has(entry));
  if (!exactSet(seenTables, tableSet) || seenTables.size !== dumpCounts.tables) {
    fail("TABLE_DRIFT", "The decrypted dump does not preserve the exact 70 raw parity tables.");
  }
  if (!exactSet(seenFunctions, expectedFunctions) || seenFunctions.size !== dumpCounts.functions) {
    fail("FUNCTION_DRIFT", "The decrypted dump does not contain the exact frozen function set.");
  }
  if (!exactSet(seenPolicies, expectedPolicyKeys) || seenPolicies.size !== dumpCounts.policies) {
    fail("POLICY_DRIFT", "The decrypted dump does not contain the exact frozen public policy set.");
  }
  if (triggerCount !== dumpCounts.triggers) {
    fail("TRIGGER_DRIFT", "The decrypted dump trigger count differs from encrypted evidence.");
  }
  if (explicitIndexCount !== dumpCounts.explicitIndexes) {
    fail("INDEX_DRIFT", "The decrypted dump index count differs from encrypted evidence.");
  }
  if (withheldRpcKeyHashes.length !== contract.expected.applicationRpcs) {
    fail("FUNCTION_DRIFT", "The decrypted dump does not contain the exact 16 withheld RPC contracts.");
  }
  return {
    crossSchemaAuthForeignKeysTranslated,
    dependentObjects,
    explicitIndexCount,
    rawParity,
    seenPolicies,
    triggerCount,
    withheldRpcKeyHashes: withheldRpcKeyHashes.sort(),
  };
}

function assertNoPlaintextInReport(report, sourceText, phases) {
  const serialized = JSON.stringify(report);
  const longSourceFragments = sourceText
    .split(/\s+/)
    .filter((fragment) => fragment.length >= 48);
  if (longSourceFragments.some((fragment) => serialized.includes(fragment))) {
    fail("PLAINTEXT_REPORT_LEAK", "The sanitized compiler report contains source schema text.");
  }
  if (Object.values(phases).some((phase) => serialized.includes(phase.slice(0, 128)))) {
    fail("PLAINTEXT_REPORT_LEAK", "The sanitized compiler report contains compiled SQL text.");
  }
  if (SECRET_SHAPED_PATTERN.some((pattern) => pattern.test(serialized))) {
    fail("PLAINTEXT_REPORT_LEAK", "The sanitized compiler report contains secret-shaped material.");
  }
  assertSafeForStdout(report);
}

export function validateCompiledTargetSchema({ phases, contract = SOURCE_CONTRACT }) {
  if (!phases || Object.keys(phases).sort().join(",") !== [...TARGET_SCHEMA_PHASES].sort().join(",")) {
    fail("COMPILED_PHASE_DRIFT", "The compiler must emit the exact seven reviewed phases.");
  }
  for (const [name, sql] of Object.entries(phases)) {
    const requiredPrefix = `-- ${name}\n-- Private review artifact. Execution is disabled by the first transaction statement.\n${PLAN_GUARD}`;
    if (typeof sql !== "string" || !sql.startsWith(requiredPrefix)) {
      fail("PLAN_GUARD_MISSING", `${name} is not guarded as plan-only.`);
    }
    if (!sql.trimEnd().endsWith("ROLLBACK;")) {
      fail("PLAN_GUARD_MISSING", `${name} does not end in an unconditional rollback.`);
    }
    const parsed = splitPostgresStatements(sql);
    if (
      parsed[0]?.toUpperCase() !== "BEGIN;" ||
      parsed.at(-1)?.toUpperCase() !== "ROLLBACK;" ||
      parsed.slice(1, -1).some((statement) => TRANSACTION_CONTROL_PATTERN.test(statement))
    ) {
      fail("PLAN_GUARD_BYPASS", `${name} contains transaction control that can bypass plan-only mode.`);
    }
  }
  const combined = Object.values(phases)
    .flatMap((phase) => splitPostgresStatements(phase))
    .join("\n");
  if (
    executablePatternTest(combined, SOURCE_AUTH_CALL_PATTERN) ||
    executablePatternTest(combined, SOURCE_AUTH_SCHEMA_PATTERN)
  ) {
    fail("UNMAPPED_AUTH_DEPENDENCY", "Compiled SQL still references the source auth schema.");
  }
  if (executablePatternTest(combined, SOURCE_STORAGE_SCHEMA_PATTERN)) {
    fail("SOURCE_SCHEMA_DEPENDENCY", "Compiled SQL still references the source storage schema.");
  }
  if (executablePatternTest(combined, SOURCE_EXTENSIONS_SCHEMA_PATTERN)) {
    fail("SOURCE_SCHEMA_DEPENDENCY", "Compiled SQL still references the source extensions schema.");
  }
  const canonicalCombined = canonicalizeSourceIdentifiers(combined);
  if (/\bGRANT\b[\s\S]{0,300}\bTO\s+(?:PUBLIC|anon|authenticated|authenticator|service_role|supabase_admin)\b/i.test(canonicalCombined)) {
    fail("SOURCE_PRIVILEGE_RETAINED", "Compiled SQL grants access to a source or public role.");
  }
  if (/\bALTER\s+ROLE\b[\s\S]{0,300}\b(?:SUPERUSER|BYPASSRLS|CREATEDB|CREATEROLE|REPLICATION)\b/i.test(combined)) {
    fail("ELEVATED_RUNTIME_ROLE", "Compiled SQL elevates a target role.");
  }
  if (
    executablePatternTest(
      combined,
      /\b(?:SET\s+(?:LOCAL\s+)?ROLE|SET\s+SESSION\s+AUTHORIZATION)\b/i
    )
  ) {
    fail("TARGET_ROLE_SWITCH", "Compiled SQL attempts to switch into another database role.");
  }
  if (new RegExp(`\\bOWNER\\s+TO\\s+${TARGET_DATABASE_ROLES.runtime}\\b`, "i").test(combined)) {
    fail("RUNTIME_OBJECT_OWNERSHIP", "The runtime role owns a target schema object.");
  }
  for (const role of [
    TARGET_DATABASE_ROLES.migration,
    TARGET_DATABASE_ROLES.audit,
    TARGET_DATABASE_ROLES.rollback,
  ]) {
    if (new RegExp(`\\bOWNER\\s+TO\\s+${role}\\b`, "i").test(combined)) {
      fail("OPERATIONAL_OBJECT_OWNERSHIP", "An operational role owns a target schema object.");
    }
  }
  for (const statement of Object.values(phases).flatMap((phase) => splitPostgresStatements(phase))) {
    const structure = structuralSql(canonicalizeSourceIdentifiers(statement));
    if (
      /\bOWNER\s+TO\b/i.test(structure) &&
      !new RegExp(`\\bOWNER\\s+TO\\s+${TARGET_SCHEMA_OWNER_ROLE};$`, "i").test(structure)
    ) {
      fail("OWNER_MAPPING_GAP", "A target object is assigned outside the exact sealed owner mapping.");
    }
    if (/^(?:GRANT|REVOKE)\b/i.test(structure) && !/\bON\b/i.test(structure)) {
      fail("INHERITED_ROLE_GRANT", "The plan contains unreviewed database-role membership DDL.");
    }
  }
  for (const role of TARGET_BOUNDARY_ROLES) {
    if (
      new RegExp(
        `\\bGRANT\\b(?:(?!\\bON\\b)[\\s\\S]){1,160}\\bTO\\s+${role}\\b`,
        "i"
      ).test(canonicalCombined)
    ) {
      fail("INHERITED_ROLE_GRANT", "The plan grants role membership to a target boundary role.");
    }
  }
  if (
    new RegExp(
      `\\bGRANT\\b[\\s\\S]{0,180}\\bON\\s+TABLE\\s+(?:hushh_identity\\.identity_links|hushh_migration\\.)[\\s\\S]{0,100}\\bTO\\s+${TARGET_DATABASE_ROLES.runtime}\\b`,
      "i"
    ).test(combined)
  ) {
    fail("IDENTITY_PRIVILEGE_GAP", "The runtime role has direct operational metadata access.");
  }
  if (/\bCREATE\s+(?:ROLE|USER|DATABASE|SUBSCRIPTION)\b/i.test(combined)) {
    fail("TARGET_BOUNDARY_DDL", "Compiled SQL attempts to create an external target boundary object.");
  }

  const extensionPhase = phases["00_extension_and_role_preflight.sql.plan"];
  for (const extension of ["pgcrypto", '"uuid-ossp"', "vector"]) {
    if (!extensionPhase.includes(`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA public;`)) {
      fail("EXTENSION_DISPOSITION_REQUIRED", "A reviewed pre-table extension disposition is absent.");
    }
  }
  for (const invariant of [
    `'${TARGET_SCHEMA_OWNER_ROLE}'`,
    "role_record.rolcanlogin",
    "role_record.rolinherit",
    "pg_catalog.pg_auth_members",
    "sealed schema-owner role must be NOLOGIN and NOINHERIT",
    "sealed schema-owner role must not inherit or SET ROLE into any role",
    "sealed schema-owner role must have no member before governed executor review",
    "operational role owns or can SET ROLE into a protected object owner",
  ]) {
    if (!extensionPhase.includes(invariant)) {
      fail("OWNER_ATTESTATION_GAP", "The preflight omits a sealed owner or membership proof.");
    }
  }

  const parityPhase = phases["20_raw_parity_schema.sql.plan"];
  const compiledTables = [...parityPhase.matchAll(/\bCREATE\s+TABLE\s+public\.("(?:""|[^"])+"|[a-z_][a-z0-9_]*)/gi)].map(
    (match) => unquoteIdentifier(match[1])
  );
  if (
    compiledTables.length !== contract.expected.publicTables ||
    new Set(compiledTables).size !== contract.expected.publicTables ||
    compiledTables.some((table) => !contract.publicTables.includes(table))
  ) {
    fail("TABLE_DRIFT", "Compiled raw parity phase does not preserve exactly 70 tables.");
  }
  for (const table of contract.publicTables) {
    if (
      !parityPhase.includes(
        `ALTER TABLE public.${quoteIdentifier(table)} OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`
      )
    ) {
      fail("OWNER_MAPPING_GAP", "A raw parity table lacks its exact sealed owner mapping.");
    }
  }

  const identityPhase = phases["10_firebase_identity_context.sql.plan"];
  for (const invariant of [
    "legacy_user_uuid uuid NOT NULL",
    "identity_links_legacy_principal_uidx",
    "UNCLAIMED_LEGACY_PRINCIPAL",
    "firebase_uid IS NULL",
    "current_setting('app.firebase_uid', true)",
    "links.status = 'ACTIVE'",
    "SECURITY DEFINER",
    `ALTER FUNCTION hushh_identity.current_legacy_user_uuid() OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
    `REVOKE ALL ON TABLE hushh_identity.identity_links FROM ${TARGET_DATABASE_ROLES.runtime};`,
    `CREATE POLICY identity_links_owner_active_lookup ON hushh_identity.identity_links FOR SELECT TO ${TARGET_SCHEMA_OWNER_ROLE}`,
    `ALTER SCHEMA public OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
    `ALTER SEQUENCE hushh_migration.migration_audit_events_id_seq OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`,
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!identityPhase.includes(invariant)) {
      fail("IDENTITY_FOUNDATION_GAP", "Compiled identity phase is missing a denial or provenance invariant.");
    }
  }
  if (
    /GRANT\s+(?:[\s\S]{0,80})?ON\s+TABLE\s+hushh_identity\.identity_links\s+TO\s+hushh_tech_runtime/i.test(
      identityPhase
    ) ||
    !identityPhase.includes(
      `GRANT EXECUTE ON FUNCTION hushh_identity.current_legacy_user_uuid() TO ${TARGET_DATABASE_ROLES.runtime};`
    )
  ) {
    fail("IDENTITY_PRIVILEGE_GAP", "Runtime identity resolution is not helper-only.");
  }
  const identityHelper = splitPostgresStatements(identityPhase).find((statement) =>
    /^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+hushh_identity\.current_legacy_user_uuid\s*\(/i.test(
      statement,
    ),
  );
  if (!identityHelper) {
    fail("IDENTITY_FOUNDATION_GAP", "The hardened legacy identity helper is absent.");
  }
  assertTrustedSecurityDefinerConfiguration(identityHelper, true);

  const functionPhase = phases["30_constraints_triggers_indexes.sql.plan"];
  if (/\bCREATE\s+OR\s+REPLACE(?:\s+CONSTRAINT)?\s+TRIGGER\b/i.test(functionPhase)) {
    fail(
      "TRIGGER_REPLACE_NOT_ALLOWED",
      "Compiled trigger DDL must fail closed instead of replacing an existing trigger."
    );
  }
  const functionStatements = splitPostgresStatements(functionPhase);
  const retainedFunctionNames = [];
  for (let index = 0; index < functionStatements.length; index += 1) {
    const statement = functionStatements[index];
    const name = extractFunctionName(statement);
    if (!name) continue;
    retainedFunctionNames.push(name);
    const signature = contract.customPublicFunctionSignatures.find(
      (entry) => entry.startsWith(`${name}(`) && entry.endsWith("->trigger")
    );
    if (!signature) fail("FUNCTION_DRIFT", "A non-trigger source function remains in the target plan.");
    const parsedFunction = parseFunctionContract(statement, contract);
    assertTrustedSecurityDefinerConfiguration(statement, parsedFunction.securityDefiner);
    if (executablePatternTest(statement, /\bEXECUTE\b/i)) {
      fail(
        "DYNAMIC_SQL_BLOCKED",
        "A retained function contains dynamic SQL that has not been fully parsed and reviewed.",
      );
    }
    const ref = `public.${quoteIdentifier(name)}(${functionIdentityArgumentTypes(signature)})`;
    const immediate = functionStatements.slice(index + 1, index + 8).join("\n");
    if (
      !immediate.includes(`ALTER FUNCTION ${ref} OWNER TO ${TARGET_SCHEMA_OWNER_ROLE};`) ||
      !immediate.includes(`REVOKE ALL ON FUNCTION ${ref} FROM PUBLIC;`) ||
      TARGET_BOUNDARY_ROLES.some(
        (role) => !immediate.includes(`REVOKE ALL ON FUNCTION ${ref} FROM ${role};`)
      )
    ) {
      fail("FUNCTION_PRIVILEGE_WINDOW", "A retained trigger function is not immediately hardened.");
    }
  }
  const expectedTriggerNames = contract.customPublicFunctionSignatures
    .filter((signature) => signature.endsWith("->trigger"))
    .map((signature) => signature.slice(0, signature.indexOf("(")))
    .sort();
  if (
    retainedFunctionNames.length !== contract.expected.customTriggerFunctions ||
    [...retainedFunctionNames].sort().join("\u0000") !== expectedTriggerNames.join("\u0000")
  ) {
    fail("FUNCTION_DRIFT", "The target plan must retain exactly the eight frozen trigger functions.");
  }
  for (const name of expectedTriggerNames) {
    if (
      new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.\\"?${name}\\"?[\\s\\S]{0,120}\\bTO\\s+${TARGET_DATABASE_ROLES.runtime}\\b`,
        "i"
      ).test(combined)
    ) {
      fail("FUNCTION_PRIVILEGE_WINDOW", "Runtime execute was granted on a retained trigger function.");
    }
  }
  const rpcNames = contract.customPublicFunctionSignatures
    .filter((signature) => !signature.endsWith("->trigger"))
    .map((signature) => signature.slice(0, signature.indexOf("(")));
  for (const name of rpcNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`CREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+public\\.\\"?${escaped}\\"?\\s*\\(`, "i").test(
        combined
      ) ||
      new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.\\"?${escaped}\\"?`, "i").test(
        combined
      )
    ) {
      fail(
        GENERIC_DELETE_FUNCTIONS.includes(name) ? "PUBLIC_DELETE_RPC" : "LEGACY_RPC_RETAINED",
        "A withheld legacy RPC remains callable in the target plan."
      );
    }
  }

  const rlsPhase = phases["40_firebase_rls_policies.sql.plan"];
  for (const table of contract.publicTables) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`ALTER TABLE public\\.\"${escaped}\" ENABLE ROW LEVEL SECURITY;`).test(rlsPhase)) {
      fail("RLS_GAP", "A raw parity table is missing ENABLE ROW LEVEL SECURITY.");
    }
    if (!new RegExp(`ALTER TABLE public\\.\"${escaped}\" FORCE ROW LEVEL SECURITY;`).test(rlsPhase)) {
      fail("RLS_GAP", "A raw parity table is missing FORCE ROW LEVEL SECURITY.");
    }
  }
  const policyCount = (rlsPhase.match(/\bCREATE\s+POLICY\b/g) ?? []).length;
  if (policyCount !== 280) {
    fail("POLICY_DRIFT", "Compiled runtime and operational policy counts differ from the reviewed plan.");
  }
  const runtimePolicyStatements = splitPostgresStatements(rlsPhase).filter(
    (statement) =>
      /^CREATE\s+POLICY\b/i.test(statement) &&
      new RegExp(`\\bTO\\s+${TARGET_DATABASE_ROLES.runtime}\\b`, "i").test(statement)
  );
  const expectedRuntimePolicyKeys = new Set(
    contract.firebasePolicyMapping.firebaseOwnershipPolicies.map(
      ([table, policy]) => `${table}\u0000${policy}`
    )
  );
  const actualRuntimePolicyKeys = new Set(runtimePolicyStatements.map(extractPolicyKey));
  if (
    runtimePolicyStatements.length !== 70 ||
    actualRuntimePolicyKeys.size !== 70 ||
    [...actualRuntimePolicyKeys].some((key) => !expectedRuntimePolicyKeys.has(key)) ||
    runtimePolicyStatements.some(
      (statement) =>
        /\bUSING\s*\(\s*true\s*\)/i.test(statement) ||
        /\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(statement) ||
        /\bauth\s*\.\s*jwt\s*\(/i.test(statement)
    )
  ) {
    fail("POLICY_MAPPING_GAP", "Runtime policies differ from the explicit 70-policy ownership map.");
  }

  const privilegePhase = phases["50_target_privileges.sql.plan"];
  if (!privilegePhase.includes("REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM PUBLIC;")) {
    fail(
      "OPERATIONAL_TEMP_PRIVILEGE",
      "The database PUBLIC role is not explicitly denied temporary-object creation.",
    );
  }
  for (const name of GENERIC_DELETE_FUNCTIONS) {
    if (new RegExp(`\\b(?:CREATE|GRANT)\\b[\\s\\S]{0,160}public\\.\\"?${name}\\"?`, "i").test(combined)) {
      fail("PUBLIC_DELETE_RPC", "A generic deletion function is granted to the runtime role.");
    }
  }
  for (const role of TARGET_OPERATIONAL_ROLES) {
    for (const revocation of [
      `REVOKE CREATE ON DATABASE hushh_tech_app FROM ${role};`,
      `REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM ${role};`,
      `REVOKE CREATE ON SCHEMA public FROM ${role};`,
      `REVOKE CREATE ON SCHEMA hushh_identity FROM ${role};`,
      `REVOKE CREATE ON SCHEMA hushh_migration FROM ${role};`,
    ]) {
      if (!privilegePhase.includes(revocation)) {
        fail(
          revocation.includes("TEMPORARY")
            ? "OPERATIONAL_TEMP_PRIVILEGE"
            : "OPERATIONAL_DDL_PRIVILEGE",
          "An operational role is not explicitly denied CREATE or temporary-object privileges.",
        );
      }
    }
  }
  for (const table of [
    "identity_links",
    "migration_runs",
    "identity_migration_dispositions",
    "migration_checkpoints",
    "migration_audit_events",
    "migration_outbox",
  ]) {
    if (!identityPhase.includes(`${table}_migration_all`) && table !== "identity_links") {
      fail("OPERATIONAL_RLS_GAP", "An operational table lacks a migration policy.");
    }
  }
  const catalogPhase = phases["60_catalog_validation.sql.plan"];
  for (const proof of [
    "pg_catalog.pg_has_role",
    "pg_catalog.pg_auth_members",
    "runtime role owns a protected schema object",
    "public schema contains missing or extra raw-parity tables",
    "runtime role can execute a retained legacy trigger function",
    "target column, constraint, index, or trigger count mismatch",
    "operational role owns or can SET ROLE into a protected object owner",
    "operational role exceeds the no-DDL or TEMP boundary",
    "has_database_privilege(role_name, current_database(), 'TEMPORARY')",
    "security-definer search_path configuration mismatch",
    `ARRAY['${TRUSTED_SECURITY_DEFINER_PROCONFIG}']::text[]`,
    "sealed schema-owner role must be NOLOGIN and NOINHERIT",
    "sealed schema-owner role must not inherit or SET ROLE into any role",
    "sealed schema-owner role must have no member before governed executor review",
    "exact expected schema, table, sequence, or function owner mapping mismatch",
    `rolname = '${TARGET_SCHEMA_OWNER_ROLE}'`,
  ]) {
    if (!catalogPhase.includes(proof)) {
      fail("CATALOG_PROOF_GAP", "The catalog phase omits a required ownership or privilege proof.");
    }
  }
  return true;
}

export function compileTargetSchema({
  dumpBytes,
  identityFoundationSql,
  contract = SOURCE_CONTRACT,
  dumpEvidence = contract.frozenEncryptedSchemaDumpEvidence,
} = {}) {
  if (!Buffer.isBuffer(dumpBytes)) fail("SCHEMA_DUMP_INVALID", "Schema dump bytes are required.");
  if (typeof identityFoundationSql !== "string") {
    fail("IDENTITY_FOUNDATION_UNAVAILABLE", "The checked-in identity foundation SQL is required.");
  }
  assertExactKeys(
    dumpEvidence.dump,
    [
      "plaintextSha256",
      "compressedPlaintextSha256",
      "compressedPlaintextBytes",
      "bytes",
      "lines",
      "tables",
      "functions",
      "policies",
      "triggers",
      "explicitIndexes",
      "copyOrInsertStatements",
      "containsData",
    ],
    "encrypted schema-dump evidence"
  );
  const observedHash = sha256(dumpBytes);
  if (observedHash !== dumpEvidence.dump.plaintextSha256) {
    fail("SCHEMA_DUMP_HASH_MISMATCH", "The decrypted schema dump does not match frozen encrypted evidence.");
  }
  if (dumpBytes.length !== dumpEvidence.dump.bytes || countNewlines(dumpBytes) !== dumpEvidence.dump.lines) {
    fail("SCHEMA_DUMP_SHAPE_MISMATCH", "The decrypted schema dump byte or line count has drifted.");
  }
  if (dumpEvidence.dump.containsData !== false || dumpEvidence.dump.copyOrInsertStatements !== 0) {
    fail("SCHEMA_DUMP_CONTAINS_DATA", "Frozen evidence does not describe a schema-only dump.");
  }
  const sourceText = dumpBytes.toString("utf8");
  if (Buffer.from(sourceText, "utf8").compare(dumpBytes) !== 0) {
    fail("SCHEMA_DUMP_ENCODING_INVALID", "The decrypted schema dump must be canonical UTF-8.");
  }
  const statements = splitPostgresStatements(sourceText);
  const classified = classifySourceStatements(statements, contract, dumpEvidence);
  const normalizedIdentityFoundation = normalizeIdentityFoundation(identityFoundationSql);
  const generatedPolicies = buildFirebasePolicies(contract, new Set(contract.publicTables));
  if (
    generatedPolicies.sourceKeys.size !== classified.seenPolicies.size ||
    [...generatedPolicies.sourceKeys].some((key) => !classified.seenPolicies.has(key))
  ) {
    fail("POLICY_DRIFT", "Sanitized policy evidence and the decrypted dump do not match.");
  }

  const phases = {
    "00_extension_and_role_preflight.sql.plan": wrapPlanOnlyPhase(
      "00_extension_and_role_preflight.sql.plan",
      extensionAndRolePreflightSql()
    ),
    "10_firebase_identity_context.sql.plan": wrapPlanOnlyPhase(
      "10_firebase_identity_context.sql.plan",
      `${normalizedIdentityFoundation}\n\n${firebaseIdentityContextSql()}\n\n${operationalMetadataSql()}`
    ),
    "20_raw_parity_schema.sql.plan": wrapPlanOnlyPhase(
      "20_raw_parity_schema.sql.plan",
      classified.rawParity.join("\n\n")
    ),
    "30_constraints_triggers_indexes.sql.plan": wrapPlanOnlyPhase(
      "30_constraints_triggers_indexes.sql.plan",
      classified.dependentObjects.join("\n\n")
    ),
    "40_firebase_rls_policies.sql.plan": wrapPlanOnlyPhase(
      "40_firebase_rls_policies.sql.plan",
      `${buildRlsSql(contract.publicTables)}\n\n${generatedPolicies.sql}\n\n${buildOperationalPublicPolicies(contract.publicTables)}`
    ),
    "50_target_privileges.sql.plan": wrapPlanOnlyPhase(
      "50_target_privileges.sql.plan",
      buildPrivilegesSql(contract)
    ),
    "60_catalog_validation.sql.plan": wrapPlanOnlyPhase(
      "60_catalog_validation.sql.plan",
      buildCatalogValidationSql(contract)
    ),
  };
  validateCompiledTargetSchema({ phases, contract });

  const phaseEvidence = TARGET_SCHEMA_PHASES.map((name) => ({
    name,
    sha256: sha256(Buffer.from(phases[name], "utf8")),
    bytes: Buffer.byteLength(phases[name], "utf8"),
    planGuard: true,
  }));
  const report = {
    version: 1,
    state: "COMPILED_PRIVATE_PLAN_ONLY",
    sourceEvidence: {
      plaintextSha256: observedHash,
      encryptedEvidenceArtifactSha256:
        contract.frozenEncryptedSchemaDumpEvidenceArtifact?.sha256 ?? null,
      sanitizedFactsArtifactSha256: contract.frozenSchemaFactsArtifact?.sha256 ?? null,
      captureHashesArtifactSha256: contract.frozenSchemaCaptureHashesArtifact?.sha256 ?? null,
      firebasePolicyMappingArtifactSha256:
        contract.firebasePolicyMappingArtifact?.sha256 ?? null,
      bodyProof: "MONOLITHIC_REVIEWED_PLAINTEXT_SHA256",
      independentCaptureHashes: "LOADED_AND_ARTIFACT_BOUND_NOT_REDERIVED",
    },
    counts: {
      rawParityTables: contract.expected.publicTables,
      sourcePublicPoliciesDispositioned: contract.expected.livePublicPolicies,
      publicPoliciesTranslated:
        contract.firebasePolicyMapping.expected.firebaseOwnershipPolicies,
      publicPoliciesBlocked: contract.firebasePolicyMapping.expected.blockedPolicies,
      storagePoliciesExcludedForGcs: contract.expected.liveStoragePolicies,
      sourceCustomFunctionsDispositioned: contract.expected.liveCustomPublicFunctions,
      legacyRpcsWithheld: contract.expected.applicationRpcs,
      triggerFunctionsRetained: contract.expected.customTriggerFunctions,
      genericDeleteFunctionsWithheld: GENERIC_DELETE_FUNCTIONS.length,
      triggers: classified.triggerCount,
      explicitIndexes: classified.explicitIndexCount,
      authUsersForeignKeysTranslated: classified.crossSchemaAuthForeignKeysTranslated,
    },
    identity: {
      canonicalIdentifier: "FIREBASE_UID",
      legacyUuidProvenance: "PRESERVED",
      requestContext: "TRANSACTION_LOCAL_APP_FIREBASE_UID",
      unclaimedLegacyPrincipalAccess: "DENIED",
      emailOnlyMapping: "FORBIDDEN",
      unclaimedLegacyPrincipals: contract.expected.unclaimedLegacyPrincipals,
    },
    dispositions: {
      blockedPolicyKeyHashes: generatedPolicies.blockedKeyHashes,
      withheldRpcKeyHashes: classified.withheldRpcKeyHashes,
      legacyRpcRuntimeAllowlist: "EMPTY",
      sourceExtensionSet: "BLOCKED_PENDING_EXACT_SIX_EXTENSION_REVIEW",
    },
    phases: phaseEvidence,
    execution: {
      mode: "PLAN_ONLY",
      applyReady: false,
      liveConnectionsAvailable: false,
      blockers: [
        "PLAN_ONLY_EXECUTION",
        "GOVERNED_EXECUTOR_NOT_PRESENT",
        "SEALED_SCHEMA_OWNER_EXECUTOR_BINDING_REQUIRED",
        "LIVE_TARGET_ATTESTATION_REQUIRED",
        "48_SOURCE_POLICY_CONTRACTS_BLOCKED",
        "16_LEGACY_RPC_CONTRACTS_BLOCKED",
        "SOURCE_EXTENSION_SET_REVIEW_REQUIRED",
        ...(observedHash === contract.frozenEncryptedSchemaDumpEvidence.dump.plaintextSha256
          ? []
          : ["REAL_DUMP_OFFLINE_COMPILE_REQUIRED"]),
      ],
    },
  };
  report.planSha256 = canonicalHash(reportEnvelopeWithoutDigest(report));
  assertNoPlaintextInReport(report, sourceText, phases);
  const frozenPhases = freezeDeep({ ...phases });
  const frozenReport = freezeDeep(report);
  const dumpEvidenceSnapshot = cloneJsonEvidence(dumpEvidence);
  COMPILED_PLAN_RUNS.set(frozenReport, {
    contract,
    contractSha256: canonicalHash(contract),
    dumpEvidence: dumpEvidenceSnapshot,
    dumpEvidenceSha256: canonicalHash(dumpEvidenceSnapshot),
    identityFoundationSha256: sha256(Buffer.from(identityFoundationSql, "utf8")),
    phases: frozenPhases,
    plaintextSha256: observedHash,
    reportSha256: canonicalHash(frozenReport),
  });
  return { phases: frozenPhases, report: frozenReport };
}

function validatePlanReport(report, phases, contract) {
  const hasPrivatePhaseBytes = phases !== null && phases !== undefined;
  assertExactKeys(
    report,
    [
      "version",
      "state",
      "sourceEvidence",
      "counts",
      "identity",
      "dispositions",
      "phases",
      "execution",
      "planSha256",
    ],
    "target schema report"
  );
  assertExactKeys(
    report.sourceEvidence,
    [
      "plaintextSha256",
      "encryptedEvidenceArtifactSha256",
      "sanitizedFactsArtifactSha256",
      "captureHashesArtifactSha256",
      "firebasePolicyMappingArtifactSha256",
      "bodyProof",
      "independentCaptureHashes",
    ],
    "target schema source evidence"
  );
  assertExactKeys(
    report.counts,
    [
      "rawParityTables",
      "sourcePublicPoliciesDispositioned",
      "publicPoliciesTranslated",
      "publicPoliciesBlocked",
      "storagePoliciesExcludedForGcs",
      "sourceCustomFunctionsDispositioned",
      "legacyRpcsWithheld",
      "triggerFunctionsRetained",
      "genericDeleteFunctionsWithheld",
      "triggers",
      "explicitIndexes",
      "authUsersForeignKeysTranslated",
    ],
    "target schema counts"
  );
  assertExactKeys(
    report.identity,
    [
      "canonicalIdentifier",
      "legacyUuidProvenance",
      "requestContext",
      "unclaimedLegacyPrincipalAccess",
      "emailOnlyMapping",
      "unclaimedLegacyPrincipals",
    ],
    "target schema identity disposition"
  );
  assertExactKeys(
    report.dispositions,
    [
      "blockedPolicyKeyHashes",
      "withheldRpcKeyHashes",
      "legacyRpcRuntimeAllowlist",
      "sourceExtensionSet",
    ],
    "target schema blocked dispositions"
  );
  assertExactKeys(
    report.execution,
    ["mode", "applyReady", "liveConnectionsAvailable", "blockers"],
    "target schema execution boundary"
  );
  const expectedCounts = {
    rawParityTables: 70,
    sourcePublicPoliciesDispositioned: 118,
    publicPoliciesTranslated: 70,
    publicPoliciesBlocked: 48,
    storagePoliciesExcludedForGcs: 10,
    sourceCustomFunctionsDispositioned: 24,
    legacyRpcsWithheld: 16,
    triggerFunctionsRetained: 8,
    genericDeleteFunctionsWithheld: 4,
    triggers: 24,
    explicitIndexes: 121,
  };
  if (
    report.version !== 1 ||
    report.state !== "COMPILED_PRIVATE_PLAN_ONLY" ||
    Object.entries(expectedCounts).some(([key, value]) => report.counts[key] !== value) ||
    !Number.isSafeInteger(report.counts.authUsersForeignKeysTranslated) ||
    report.counts.authUsersForeignKeysTranslated < 0 ||
    report.identity.canonicalIdentifier !== "FIREBASE_UID" ||
    report.identity.legacyUuidProvenance !== "PRESERVED" ||
    report.identity.requestContext !== "TRANSACTION_LOCAL_APP_FIREBASE_UID" ||
    report.identity.unclaimedLegacyPrincipalAccess !== "DENIED" ||
    report.identity.emailOnlyMapping !== "FORBIDDEN" ||
    report.identity.unclaimedLegacyPrincipals !== 65 ||
    report.dispositions.legacyRpcRuntimeAllowlist !== "EMPTY" ||
    report.dispositions.sourceExtensionSet !== "BLOCKED_PENDING_EXACT_SIX_EXTENSION_REVIEW"
  ) {
    fail("PLAN_REPORT_INVALID", "The compiler report counts or dispositions have drifted.");
  }
  const expectedBlockedPolicyHashes = contract.firebasePolicyMapping.blockedPolicies
    .map((entry) => sha256(Buffer.from(JSON.stringify(entry), "utf8")))
    .sort();
  const expectedRpcHashes = contract.customPublicFunctionSignatures
    .filter((signature) => !signature.endsWith("->trigger"))
    .map((signature) => sha256(Buffer.from(signature, "utf8")))
    .sort();
  if (
    !Array.isArray(report.dispositions.blockedPolicyKeyHashes) ||
    report.dispositions.blockedPolicyKeyHashes.join("\u0000") !==
      expectedBlockedPolicyHashes.join("\u0000") ||
    !Array.isArray(report.dispositions.withheldRpcKeyHashes) ||
    report.dispositions.withheldRpcKeyHashes.join("\u0000") !== expectedRpcHashes.join("\u0000")
  ) {
    fail("PLAN_REPORT_INVALID", "The report does not bind the exact blocked policy and RPC keys.");
  }
  if (
    !/^[0-9a-f]{64}$/.test(report.sourceEvidence.plaintextSha256 ?? "") ||
    report.sourceEvidence.encryptedEvidenceArtifactSha256 !==
      contract.frozenEncryptedSchemaDumpEvidenceArtifact.sha256 ||
    report.sourceEvidence.sanitizedFactsArtifactSha256 !== contract.frozenSchemaFactsArtifact.sha256 ||
    report.sourceEvidence.captureHashesArtifactSha256 !==
      contract.frozenSchemaCaptureHashesArtifact.sha256 ||
    report.sourceEvidence.firebasePolicyMappingArtifactSha256 !==
      contract.firebasePolicyMappingArtifact.sha256 ||
    report.sourceEvidence.bodyProof !== "MONOLITHIC_REVIEWED_PLAINTEXT_SHA256" ||
    report.sourceEvidence.independentCaptureHashes !==
      "LOADED_AND_ARTIFACT_BOUND_NOT_REDERIVED"
  ) {
    fail("PLAN_REPORT_INVALID", "The report source evidence binding has drifted.");
  }
  const expectedBlockers = [
    "PLAN_ONLY_EXECUTION",
    "GOVERNED_EXECUTOR_NOT_PRESENT",
    "SEALED_SCHEMA_OWNER_EXECUTOR_BINDING_REQUIRED",
    "LIVE_TARGET_ATTESTATION_REQUIRED",
    "48_SOURCE_POLICY_CONTRACTS_BLOCKED",
    "16_LEGACY_RPC_CONTRACTS_BLOCKED",
    "SOURCE_EXTENSION_SET_REVIEW_REQUIRED",
    ...(report.sourceEvidence.plaintextSha256 ===
    contract.frozenEncryptedSchemaDumpEvidence.dump.plaintextSha256
      ? []
      : ["REAL_DUMP_OFFLINE_COMPILE_REQUIRED"]),
  ];
  if (
    report.execution.mode !== "PLAN_ONLY" ||
    report.execution.applyReady !== false ||
    report.execution.liveConnectionsAvailable !== false ||
    !Array.isArray(report.execution.blockers) ||
    report.execution.blockers.join("\u0000") !== expectedBlockers.join("\u0000")
  ) {
    fail("PLAN_REPORT_INVALID", "The compiler report does not preserve the plan-only execution boundary.");
  }
  if (
    !Array.isArray(report.phases) ||
    report.phases.length !== TARGET_SCHEMA_PHASES.length ||
    report.phases.some((entry, index) => {
      assertExactKeys(entry, ["name", "sha256", "bytes", "planGuard"], "target schema phase evidence");
      const name = TARGET_SCHEMA_PHASES[index];
      return (
        entry?.name !== name ||
        entry?.planGuard !== true ||
        !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "") ||
        !Number.isSafeInteger(entry?.bytes) ||
        entry.bytes <= 0 ||
        (hasPrivatePhaseBytes &&
          (entry.sha256 !== sha256(Buffer.from(phases[name], "utf8")) ||
            entry.bytes !== Buffer.byteLength(phases[name], "utf8")))
      );
    })
  ) {
    fail("PLAN_REPORT_INVALID", "The compiler report does not bind the exact guarded phase bytes.");
  }
  if (report.planSha256 !== canonicalHash(reportEnvelopeWithoutDigest(report))) {
    fail("PLAN_REPORT_INVALID", "The report aggregate envelope digest has drifted.");
  }
  assertSafeForStdout(report);
}

export function validateTargetSchemaPlanEvidence({
  report,
  contract = SOURCE_CONTRACT,
}) {
  validatePlanReport(report, null, contract);
  return true;
}

export function validatePrivateTargetSchemaPlan({
  report,
  phases,
  contract = SOURCE_CONTRACT,
}) {
  validateCompiledTargetSchema({ phases, contract });
  validatePlanReport(report, phases, contract);
  return true;
}

export function writePrivateTargetSchemaPlan({
  outputDirectory,
  phases,
  report,
  dumpBytes,
  identityFoundationSql,
  contract = SOURCE_CONTRACT,
}) {
  const compilerRun = report && typeof report === "object" ? COMPILED_PLAN_RUNS.get(report) : null;
  if (
    !compilerRun ||
    compilerRun.phases !== phases ||
    compilerRun.contract !== contract ||
    contract !== SOURCE_CONTRACT ||
    compilerRun.contractSha256 !== canonicalHash(contract) ||
    compilerRun.dumpEvidenceSha256 !== canonicalHash(compilerRun.dumpEvidence) ||
    compilerRun.plaintextSha256 !== report?.sourceEvidence?.plaintextSha256 ||
    compilerRun.reportSha256 !== canonicalHash(report)
  ) {
    fail(
      "COMPILER_RUN_CAPABILITY_REQUIRED",
      "Private output requires the unchanged phases and report from the same compiler invocation."
    );
  }
  if (
    !Buffer.isBuffer(dumpBytes) ||
    sha256(dumpBytes) !== compilerRun.plaintextSha256 ||
    typeof identityFoundationSql !== "string" ||
    sha256(Buffer.from(identityFoundationSql, "utf8")) !== compilerRun.identityFoundationSha256
  ) {
    fail(
      "COMPILER_INPUT_MISMATCH",
      "Private output requires the exact dump bytes and identity foundation from compilation."
    );
  }
  validateCompiledTargetSchema({ phases, contract });
  validatePlanReport(report, phases, contract);
  const independentlyCompiled = compileTargetSchema({
    dumpBytes,
    identityFoundationSql,
    contract,
    dumpEvidence: compilerRun.dumpEvidence,
  });
  if (
    canonicalHash(independentlyCompiled.phases) !== canonicalHash(phases) ||
    canonicalHash(independentlyCompiled.report) !== canonicalHash(report)
  ) {
    fail(
      "COMPILER_RECOMPILE_MISMATCH",
      "Private output differs from a writer-side compilation of the supplied dump bytes."
    );
  }
  const resolvedOutput = assertPrivateOutputLocation(outputDirectory);
  let created = false;
  try {
    mkdirSync(resolvedOutput, { mode: 0o700 });
    created = true;
    chmodSync(resolvedOutput, 0o700);
    for (const name of TARGET_SCHEMA_PHASES) {
      writeFileSync(resolve(resolvedOutput, name), phases[name], { flag: "wx", mode: 0o600 });
    }
    writeFileSync(resolve(resolvedOutput, "target-schema-plan.v1.json"), `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    if (created) {
      try {
        rmSync(resolvedOutput, { recursive: true, force: true });
      } catch {
        // Keep the outward error path- and schema-free even if cleanup is denied.
      }
    }
    fail("PRIVATE_OUTPUT_WRITE_FAILED", "The private compiler output could not be written completely.");
  }
  return report;
}

export function runTargetSchemaCompilerCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  const allowed = new Set(["schema-dump", "output-dir", "dry-run", "execute", "apply"]);
  const unexpected = Object.keys(args).filter((name) => !allowed.has(name));
  if (unexpected.length > 0 || !args["schema-dump"] || !args["output-dir"]) {
    fail(
      "INVALID_ARGUMENT",
      "--schema-dump=/absolute/private/path and --output-dir=/absolute/new/path are required."
    );
  }
  assertDryRunOnly({
    dryRun: args["dry-run"] ?? true,
    execute: Object.hasOwn(args, "execute") ? true : undefined,
    apply: Object.hasOwn(args, "apply") ? true : undefined,
  });
  const { bytes } = assertPrivateInputFile(args["schema-dump"]);
  let identityFoundationSql;
  try {
    identityFoundationSql = readFileSync(IDENTITY_FOUNDATION_PATH, "utf8");
  } catch {
    fail("IDENTITY_FOUNDATION_UNAVAILABLE", "The checked-in identity foundation could not be read.");
  }
  const result = compileTargetSchema({ dumpBytes: bytes, identityFoundationSql });
  writePrivateTargetSchemaPlan({
    outputDirectory: args["output-dir"],
    phases: result.phases,
    report: result.report,
    dumpBytes: bytes,
    identityFoundationSql,
  });
  process.stdout.write(safeJsonForStdout(result.report));
  return result.report;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runTargetSchemaCompilerCli();
  } catch (error) {
    const code = error instanceof MigrationContractError ? error.code : "UNEXPECTED_ERROR";
    const message =
      error instanceof MigrationContractError
        ? error.message
        : "Target schema compilation failed without emitting private paths or schema text.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
