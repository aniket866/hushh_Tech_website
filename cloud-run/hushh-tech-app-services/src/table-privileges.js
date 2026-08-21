const TABLE_DML_PRIVILEGES = Object.freeze([
  "DELETE",
  "INSERT",
  "SELECT",
  "UPDATE",
]);
const TABLE_DML_PRIVILEGE_SET = new Set(TABLE_DML_PRIVILEGES);
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const DEFINITIONS = Object.freeze({
  "investor-api": Object.freeze([]),
  "identity-api": Object.freeze([]),
  "financial-api": Object.freeze([]),
  "content-api": Object.freeze([]),
  "engagement-api-worker": Object.freeze([]),
  "signed-webhook-service": Object.freeze([]),
  worker: Object.freeze([]),
});

function canonicalPrivilege(schema, table, privilege) {
  return `${schema}.${table}:${privilege}`;
}

function compileServiceAllowlist(serviceOwner, entries) {
  if (!Array.isArray(entries)) {
    throw new Error(`Table privilege allowlist for ${serviceOwner} must be an array.`);
  }
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !IDENTIFIER_PATTERN.test(entry.schema) ||
      !IDENTIFIER_PATTERN.test(entry.table) ||
      !Array.isArray(entry.privileges) ||
      entry.privileges.length < 1 ||
      entry.privileges.some(
        (privilege) => !TABLE_DML_PRIVILEGE_SET.has(privilege),
      ) ||
      new Set(entry.privileges).size !== entry.privileges.length ||
      Object.keys(entry).some(
        (key) => !["schema", "table", "privileges"].includes(key),
      )
    ) {
      throw new Error(`Table privilege allowlist for ${serviceOwner} is invalid.`);
    }
    for (const privilege of entry.privileges) {
      canonical.push(canonicalPrivilege(entry.schema, entry.table, privilege));
    }
  }
  canonical.sort();
  if (new Set(canonical).size !== canonical.length) {
    throw new Error(`Table privilege allowlist for ${serviceOwner} is duplicated.`);
  }
  return Object.freeze(canonical);
}

export const SERVICE_TABLE_PRIVILEGE_ALLOWLISTS = Object.freeze(
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([serviceOwner, entries]) => [
      serviceOwner,
      compileServiceAllowlist(serviceOwner, entries),
    ]),
  ),
);

export function expectedTablePrivileges(serviceOwner) {
  const privileges = SERVICE_TABLE_PRIVILEGE_ALLOWLISTS[serviceOwner];
  if (!privileges) {
    throw new Error(`Table privilege allowlist for ${serviceOwner} is missing.`);
  }
  return privileges;
}

export function observedTablePrivileges(value) {
  let entries = value;
  if (typeof value === "string") {
    try {
      entries = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(entries)) return null;
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !IDENTIFIER_PATTERN.test(entry.schema) ||
      !IDENTIFIER_PATTERN.test(entry.table) ||
      !["r", "p"].includes(entry.kind) ||
      !TABLE_DML_PRIVILEGE_SET.has(entry.privilege)
    ) {
      return null;
    }
    canonical.push(
      canonicalPrivilege(entry.schema, entry.table, entry.privilege),
    );
  }
  canonical.sort();
  if (new Set(canonical).size !== canonical.length) return null;
  return canonical;
}
