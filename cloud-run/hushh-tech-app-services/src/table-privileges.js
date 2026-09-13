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

function columnEntries(schema, table, grants) {
  return Object.freeze(
    Object.entries(grants).flatMap(([privilege, columns]) =>
      columns.map((column) =>
        Object.freeze({
          schema,
          table,
          column,
          privileges: Object.freeze([privilege]),
        }),
      ),
    ),
  );
}

const FINANCIAL_TRANSACTION_DELETE = Object.freeze([
  Object.freeze({
    schema: "public",
    table: "plaid_transactions",
    privileges: Object.freeze(["DELETE"]),
  }),
]);

const SHARED_FINANCIAL_DATA_COLUMNS = Object.freeze([
  ...columnEntries("public", "plaid_items", {
    SELECT: [
      "user_id",
      "plaid_item_id",
      "plaid_access_token_encrypted",
      "institution_id",
      "institution_name",
      "products_requested",
      "webhook_url",
      "status",
      "error_code",
      "error_message",
      "updated_at",
      "last_sync_started_at",
    ],
    INSERT: [
      "user_id",
      "plaid_item_id",
      "plaid_access_token_encrypted",
      "institution_id",
      "institution_name",
      "products_requested",
      "webhook_url",
      "status",
      "error_code",
      "error_message",
      "updated_at",
    ],
    UPDATE: [
      "plaid_access_token_encrypted",
      "institution_id",
      "institution_name",
      "products_requested",
      "webhook_url",
      "status",
      "error_code",
      "error_message",
      "updated_at",
      "last_data_sync_at",
      "last_sync_started_at",
    ],
  }),
  ...columnEntries("public", "plaid_accounts", {
    SELECT: [
      "plaid_item_id",
      "plaid_account_id",
      "name",
      "official_name",
      "type",
      "subtype",
      "current_balance",
      "available_balance",
      "iso_currency_code",
      "mask",
      "last_synced_at",
      "updated_at",
    ],
    INSERT: [
      "plaid_item_id",
      "plaid_account_id",
      "name",
      "official_name",
      "type",
      "subtype",
      "current_balance",
      "available_balance",
      "iso_currency_code",
      "mask",
      "last_synced_at",
      "updated_at",
    ],
    UPDATE: [
      "name",
      "official_name",
      "type",
      "subtype",
      "current_balance",
      "available_balance",
      "iso_currency_code",
      "mask",
      "last_synced_at",
      "updated_at",
    ],
  }),
  ...columnEntries("public", "plaid_product_sync_statuses", {
    SELECT: [
      "user_id",
      "plaid_item_id",
      "product",
      "status",
      "available",
      "records_count",
      "error_code",
      "error_message",
      "request_id",
      "attempts",
      "started_at",
      "completed_at",
      "raw_metadata",
      "created_at",
      "updated_at",
    ],
    INSERT: [
      "user_id",
      "plaid_item_id",
      "product",
      "status",
      "available",
      "records_count",
      "error_code",
      "error_message",
      "request_id",
      "attempts",
      "started_at",
      "completed_at",
      "raw_metadata",
      "updated_at",
    ],
    UPDATE: [
      "status",
      "available",
      "records_count",
      "error_code",
      "error_message",
      "request_id",
      "attempts",
      "started_at",
      "completed_at",
      "raw_metadata",
      "updated_at",
    ],
  }),
  ...columnEntries("public", "plaid_sync_cursors", {
    SELECT: [
      "plaid_item_id",
      "cursor",
      "last_synced_at",
      "product",
      "updated_at",
    ],
    INSERT: [
      "plaid_item_id",
      "cursor",
      "last_synced_at",
      "product",
      "updated_at",
    ],
    UPDATE: ["cursor", "last_synced_at", "updated_at"],
  }),
  ...columnEntries("public", "plaid_transactions", {
    SELECT: [
      "plaid_account_id",
      "plaid_transaction_id",
      "amount",
      "iso_currency_code",
      "date",
      "name",
      "merchant_name",
      "category",
      "pending",
      "payment_channel",
      "transaction_type",
      "location",
    ],
    INSERT: [
      "plaid_account_id",
      "plaid_transaction_id",
      "amount",
      "iso_currency_code",
      "date",
      "name",
      "merchant_name",
      "category",
      "pending",
      "payment_channel",
      "transaction_type",
      "location",
    ],
    UPDATE: [
      "plaid_account_id",
      "amount",
      "iso_currency_code",
      "date",
      "name",
      "merchant_name",
      "category",
      "pending",
      "payment_channel",
      "transaction_type",
      "location",
    ],
  }),
  ...columnEntries("public", "plaid_statement_metadata", {
    SELECT: [
      "user_id",
      "plaid_item_id",
      "plaid_account_id",
      "statement_id",
      "statement_date",
      "period_start",
      "period_end",
      "status",
      "metadata",
      "updated_at",
    ],
    INSERT: [
      "user_id",
      "plaid_item_id",
      "plaid_account_id",
      "statement_id",
      "statement_date",
      "period_start",
      "period_end",
      "status",
      "metadata",
      "updated_at",
    ],
    UPDATE: [
      "plaid_item_id",
      "plaid_account_id",
      "statement_date",
      "period_start",
      "period_end",
      "status",
      "metadata",
      "updated_at",
    ],
  }),
  ...columnEntries("public", "user_financial_data", {
    SELECT: [
      "user_id",
      "plaid_item_id",
      "institution_name",
      "institution_id",
      "balances",
      "asset_report",
      "asset_report_token",
      "investments",
      "available_products",
      "status",
      "fetch_errors",
      "updated_at",
      "identity_data",
      "identity_match_scores",
      "signal_prepared",
      "auth_numbers",
      "identity_match",
      "asset_report_status",
      "asset_report_created_at",
      "income_data",
      "investment_transactions",
      "liabilities_data",
      "transactions_data",
      "statements_data",
      "plaid_sync_status",
      "plaid_sync_completed_at",
      "data_sync_summary",
    ],
    INSERT: [
      "user_id",
      "plaid_item_id",
      "institution_name",
      "institution_id",
      "balances",
      "asset_report",
      "asset_report_token",
      "investments",
      "available_products",
      "status",
      "fetch_errors",
      "updated_at",
      "identity_data",
      "identity_match_scores",
      "signal_prepared",
      "auth_numbers",
      "identity_match",
      "asset_report_status",
      "asset_report_created_at",
      "income_data",
      "investment_transactions",
      "liabilities_data",
      "transactions_data",
      "statements_data",
      "plaid_sync_status",
      "plaid_sync_completed_at",
      "data_sync_summary",
    ],
    UPDATE: [
      "plaid_item_id",
      "institution_name",
      "institution_id",
      "balances",
      "asset_report",
      "asset_report_token",
      "investments",
      "available_products",
      "status",
      "fetch_errors",
      "updated_at",
      "identity_data",
      "identity_match_scores",
      "signal_prepared",
      "auth_numbers",
      "identity_match",
      "asset_report_status",
      "asset_report_created_at",
      "income_data",
      "investment_transactions",
      "liabilities_data",
      "transactions_data",
      "statements_data",
      "plaid_sync_status",
      "plaid_sync_completed_at",
      "data_sync_summary",
    ],
  }),
]);

const FINANCIAL_API_COLUMNS = Object.freeze([
  ...columnEntries("hushh_financial", "sync_jobs", {
    SELECT: [
      "id",
      "user_id",
      "firebase_uid",
      "plaid_item_id",
      "product",
      "source",
      "state",
      "attempts",
      "fencing_token",
      "lease_expires_at",
      "updated_at",
    ],
    INSERT: [
      "user_id",
      "firebase_uid",
      "plaid_item_id",
      "product",
      "source",
      "state",
      "updated_at",
    ],
    UPDATE: [
      "state",
      "attempts",
      "fencing_token",
      "lease_expires_at",
      "last_error_code",
      "updated_at",
    ],
  }),
  ...columnEntries("hushh_financial", "sync_outbox", {
    SELECT: ["job_id", "task_name", "state", "attempts"],
    INSERT: ["job_id", "task_name", "state", "updated_at"],
    UPDATE: [
      "state",
      "attempts",
      "last_error_code",
      "published_at",
      "updated_at",
    ],
  }),
  ...columnEntries("public", "onboarding_data", {
    SELECT: [
      "user_id",
      "financial_link_status",
      "updated_at",
      "legal_first_name",
      "legal_last_name",
      "phone_country_code",
      "phone_number",
      "address_line_1",
      "address_line_2",
      "city",
      "state",
      "zip_code",
      "address_country",
    ],
    INSERT: ["user_id", "financial_link_status", "updated_at"],
    UPDATE: ["financial_link_status", "updated_at"],
  }),
  ...SHARED_FINANCIAL_DATA_COLUMNS,
  ...columnEntries("public", "plaid_link_diagnostics", {
    INSERT: [
      "user_id",
      "session_id",
      "event_type",
      "plaid_step",
      "page_state",
      "plaid_metadata",
      "error_details",
      "browser_context",
    ],
  }),
]);

const WORKER_COLUMNS = Object.freeze([
  ...columnEntries("hushh_financial", "sync_jobs", {
    SELECT: [
      "id",
      "user_id",
      "firebase_uid",
      "plaid_item_id",
      "product",
      "source",
      "state",
      "attempts",
      "fencing_token",
      "lease_expires_at",
    ],
    UPDATE: [
      "state",
      "attempts",
      "fencing_token",
      "lease_expires_at",
      "last_error_code",
      "updated_at",
    ],
  }),
  ...columnEntries("public", "onboarding_data", {
    SELECT: [
      "user_id",
      "legal_first_name",
      "legal_last_name",
      "phone_country_code",
      "phone_number",
      "address_line_1",
      "address_line_2",
      "city",
      "state",
      "zip_code",
      "address_country",
    ],
  }),
  ...SHARED_FINANCIAL_DATA_COLUMNS,
]);

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
          tables:
            owner === "financial-api" || owner === "worker"
              ? FINANCIAL_TRANSACTION_DELETE
              : Object.freeze([]),
          columns: Object.freeze(
            owner === "engagement-api-worker"
              ? engagementColumns
              : owner === "financial-api"
                ? FINANCIAL_API_COLUMNS
                : owner === "worker"
                  ? WORKER_COLUMNS
                  : [],
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
