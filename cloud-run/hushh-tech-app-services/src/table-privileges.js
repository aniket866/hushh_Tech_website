const TABLE_DML_PRIVILEGES = Object.freeze([
  "DELETE",
  "INSERT",
  "SELECT",
  "UPDATE",
]);
const COLUMN_DML_PRIVILEGES = Object.freeze(["INSERT", "SELECT", "UPDATE"]);
const OBSERVABLE_COLUMN_PRIVILEGES = new Set([
  ...COLUMN_DML_PRIVILEGES,
  "REFERENCES",
]);
const SEQUENCE_PRIVILEGES = Object.freeze(["SELECT", "UPDATE", "USAGE"]);
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const DEFINITIONS = Object.freeze(
  Object.fromEntries(
    [
      "investor-api",
      "identity-api",
      "financial-api",
      "content-api",
      "engagement-api-worker",
      "signed-webhook-service",
      "worker",
    ].map((owner) => {
      const engagementColumns = [
        "id",
        "nda_version",
        "pdf_url",
        "signed_at",
        "user_id",
      ].map((column) =>
        Object.freeze({
          schema: "public",
          table: "nda_signatures",
          column,
          privileges: Object.freeze(["SELECT"]),
        }),
      );
      return [
        owner,
        Object.freeze({
          tables: Object.freeze([]),
          columns: Object.freeze(
            owner === "engagement-api-worker" ? engagementColumns : [],
          ),
          sequences: Object.freeze([]),
        }),
      ];
    }),
  ),
);

function assertIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function compileEntries(serviceOwner, kind, entries, privilegeSet, fields) {
  if (!Array.isArray(entries)) {
    throw new Error(
      `${kind} privilege allowlist for ${serviceOwner} must be an array.`,
    );
  }
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      fields.some((field) => !assertIdentifier(entry[field])) ||
      !Array.isArray(entry.privileges) ||
      entry.privileges.length < 1 ||
      entry.privileges.some((privilege) => !privilegeSet.has(privilege)) ||
      new Set(entry.privileges).size !== entry.privileges.length ||
      Object.keys(entry).some((key) => ![...fields, "privileges"].includes(key))
    ) {
      throw new Error(
        `${kind} privilege allowlist for ${serviceOwner} is invalid.`,
      );
    }
    for (const privilege of entry.privileges) {
      canonical.push(
        `${fields.map((field) => entry[field]).join(".")}:${privilege}`,
      );
    }
  }
  canonical.sort();
  if (new Set(canonical).size !== canonical.length) {
    throw new Error(
      `${kind} privilege allowlist for ${serviceOwner} is duplicated.`,
    );
  }
  return Object.freeze(canonical);
}

function compileDefinitions(key, kind, privileges, fields) {
  const privilegeSet = new Set(privileges);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(DEFINITIONS).map(([serviceOwner, definition]) => [
        serviceOwner,
        compileEntries(
          serviceOwner,
          kind,
          definition[key],
          privilegeSet,
          fields,
        ),
      ]),
    ),
  );
}

export const SERVICE_TABLE_PRIVILEGE_ALLOWLISTS = compileDefinitions(
  "tables",
  "Table",
  TABLE_DML_PRIVILEGES,
  ["schema", "table"],
);
export const SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS = compileDefinitions(
  "columns",
  "Column",
  COLUMN_DML_PRIVILEGES,
  ["schema", "table", "column"],
);
export const SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS = compileDefinitions(
  "sequences",
  "Sequence",
  SEQUENCE_PRIVILEGES,
  ["schema", "sequence"],
);

function expected(allowlists, serviceOwner, kind) {
  const privileges = allowlists[serviceOwner];
  if (!privileges) {
    throw new Error(
      `${kind} privilege allowlist for ${serviceOwner} is missing.`,
    );
  }
  return privileges;
}

export function expectedTablePrivileges(serviceOwner) {
  return expected(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS, serviceOwner, "Table");
}

export function expectedColumnPrivileges(serviceOwner) {
  return expected(SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS, serviceOwner, "Column");
}

export function expectedSequencePrivileges(serviceOwner) {
  return expected(
    SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS,
    serviceOwner,
    "Sequence",
  );
}

function parseObserved(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finalizeObserved(canonical) {
  canonical.sort();
  return new Set(canonical).size === canonical.length ? canonical : null;
}

export function observedTablePrivileges(value) {
  const entries = parseObserved(value);
  if (!Array.isArray(entries)) return null;
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !assertIdentifier(entry.schema) ||
      !assertIdentifier(entry.table) ||
      !["r", "p"].includes(entry.kind) ||
      entry.grantable !== false ||
      !TABLE_DML_PRIVILEGES.includes(entry.privilege)
    ) {
      return null;
    }
    canonical.push(`${entry.schema}.${entry.table}:${entry.privilege}`);
  }
  return finalizeObserved(canonical);
}

export function observedColumnPrivileges(value) {
  const entries = parseObserved(value);
  if (!Array.isArray(entries)) return null;
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !assertIdentifier(entry.schema) ||
      !assertIdentifier(entry.table) ||
      !assertIdentifier(entry.column) ||
      !["r", "p"].includes(entry.kind) ||
      entry.grantable !== false ||
      !OBSERVABLE_COLUMN_PRIVILEGES.has(entry.privilege)
    ) {
      return null;
    }
    canonical.push(
      `${entry.schema}.${entry.table}.${entry.column}:${entry.privilege}`,
    );
  }
  return finalizeObserved(canonical);
}

export function observedSequencePrivileges(value) {
  const entries = parseObserved(value);
  if (!Array.isArray(entries)) return null;
  const canonical = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !assertIdentifier(entry.schema) ||
      !assertIdentifier(entry.sequence) ||
      entry.grantable !== false ||
      !SEQUENCE_PRIVILEGES.includes(entry.privilege)
    ) {
      return null;
    }
    canonical.push(`${entry.schema}.${entry.sequence}:${entry.privilege}`);
  }
  return finalizeObserved(canonical);
}
