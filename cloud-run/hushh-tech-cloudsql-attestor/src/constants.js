export {
  BASE_IMAGE_DIGEST,
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
} from "./anchors.js";

export const TARGET = Object.freeze({
  environment: "uat",
  project: "hushh-tech-uat",
  region: "us-central1",
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
  postgresMajor: 17,
  auditIamDatabaseUser: "hushh-tech-audit-uat@hushh-tech-uat.iam",
  runtimeServiceAccount:
    "hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com",
});

export const BASE_PR_HEAD = "0276f9742428bb0868e288e8fa7a08287499a742";
export const HARD_PROCESS_DEADLINE_MS = 25_000;
export const WORKER_DEADLINE_MS = 22_000;
export const CLEANUP_DEADLINE_MS = 2_000;
export const MAX_OUTPUT_BYTES = 262_144;
export const MAX_POLICY_COUNT = 512;
export const MAX_POLICY_EVIDENCE_BYTES = 262_144;
export const MAX_COLLECTION_ROW_COUNT = 10_000;
export const MAX_CANONICAL_ROW_BYTES = 262_144;
export const MAX_RESULT_ROWS = 12;

export const COLLECTIONS = Object.freeze([
  "database_identity",
  "schemas",
  "relations",
  "sequences",
  "functions",
  "triggers",
  "extensions",
  "roles",
  "role_memberships",
  "object_ownership",
  "object_acls",
  "default_acls",
]);

export const CHECK_NAMES = Object.freeze([
  "databaseMatches",
  "auditRoleMatches",
  "postgres17",
  "transactionReadOnly",
  "applicationRelationsEmpty",
  "applicationSequencesEmpty",
  "applicationFunctionsEmpty",
  "applicationTriggersEmpty",
  "expectedRoleSetPresent",
  "roleFlagsSafe",
  "auditTemporaryPrivilegeDenied",
  "auditDatabaseCreateDenied",
  "auditPublicSchemaCreateDenied",
  "auditAllSchemaCreateDenied",
  "auditWritableMembershipDenied",
  "auditWritableObjectPrivilegesDenied",
  "auditWritableDefaultPrivilegesDenied",
  "catalogBoundsSatisfied",
]);
