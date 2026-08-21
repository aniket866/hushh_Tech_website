import { createHash } from "node:crypto";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  assertCheckpointContinuation,
  assertCheckpointIntegrity,
  createCheckpoint,
  createMigrationRunPlan,
} from "./checkpoints.mjs";
import {
  MigrationContractError,
  SOURCE_CONTRACT,
  assertDryRunOnly,
  assertMigrationBoundary,
} from "./contract.mjs";
import { validateTerminalDispositions } from "./identity-mapping.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_UTC_SECONDS_PATTERN =
  /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;
const FIREBASE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EMAIL_PROVIDER_IDS = new Set(["email", "password", "email_link"]);

function fail(code, message) {
  throw new MigrationContractError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function exactKeys(value, expected, code, message) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  ) {
    fail(code, message);
  }
}

function exactArray(value, expected, code, message) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(code, message);
  }
}

function validateFrozenContract(contract) {
  exactKeys(
    contract,
    [
      "version",
      "contents",
      "source",
      "authority",
      "lockedDispositions",
      "execution",
      "batching",
      "relogin",
      "calendarReconnect",
      "firebaseAdminImportSchema",
      "checkpointEvidenceSchema",
      "rollbackEvidenceSchema",
      "futureExecutorGates",
      "blockers",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Firebase identity dry-run contract has unexpected fields."
  );
  const expected = SOURCE_CONTRACT.expected;
  if (
    contract.version !== 1 ||
    contract.contents !== "SANITIZED_AGGREGATES_AND_PAYLOAD_SCHEMAS_ONLY"
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The Firebase identity dry-run contract version or contents changed."
    );
  }
  exactKeys(
    contract.source,
    ["projectRef", "inventoryContractPath", "identityRowsRepositoryStorage"],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Firebase identity source contract has unexpected fields."
  );
  if (
    contract.source.projectRef !== SOURCE_CONTRACT.source.projectRef ||
    contract.source.inventoryContractPath !==
      "migration/contracts/source-inventory.v1.json" ||
    contract.source.identityRowsRepositoryStorage !== "FORBIDDEN"
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The Firebase identity source boundary changed."
    );
  }
  assertAuthorityBinding(contract.authority);
  exactKeys(
    contract.lockedDispositions,
    [
      "authUsers",
      "linkedExistingFirebase",
      "importedFirebase",
      "appleWithoutEmail",
      "emailSignInUsers",
      "unclaimedLegacyPrincipals",
      "emailOnlyLinks",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Firebase identity disposition contract has unexpected fields."
  );
  const counts = contract.lockedDispositions;
  if (
    counts.authUsers !== expected.authUsers ||
    counts.linkedExistingFirebase !== expected.existingFirebaseProviderLinks ||
    counts.importedFirebase !== expected.newFirebaseIdentities ||
    counts.appleWithoutEmail !== expected.appleUsersWithoutEmail ||
    counts.emailSignInUsers !== expected.emailPasswordUsers ||
    counts.unclaimedLegacyPrincipals !== expected.unclaimedLegacyPrincipals ||
    counts.emailOnlyLinks !== 0
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The Firebase identity disposition baseline changed."
    );
  }
  exactKeys(
    contract.execution,
    [
      "mode",
      "executionEnabled",
      "liveSourceReads",
      "firebaseAdminReads",
      "firebaseAdminWrites",
      "gcpWrites",
      "productionMutations",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Firebase execution contract has unexpected fields."
  );
  if (
    contract.execution.mode !== "DRY_RUN" ||
    Object.entries(contract.execution).some(
      ([key, value]) => key !== "mode" && value !== false
    )
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "Firebase identity execution must remain fully disabled."
    );
  }
  exactKeys(
    contract.batching,
    [
      "dispositionBatchSize",
      "firebaseImportBatchSize",
      "firebaseAdminMaximumBatchSize",
      "order",
      "resume",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Firebase batching contract has unexpected fields."
  );
  if (
    contract.batching.dispositionBatchSize !== 100 ||
    contract.batching.firebaseImportBatchSize !== 100 ||
    contract.batching.firebaseAdminMaximumBatchSize !== 1000 ||
    contract.batching.firebaseImportBatchSize >
      contract.batching.firebaseAdminMaximumBatchSize ||
    contract.batching.order !== "LEGACY_UUID_ASCENDING" ||
    contract.batching.resume !== "HASH_CHAINED_CHECKPOINTS"
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The Firebase batching and resume policy changed."
    );
  }
  exactKeys(
    contract.relogin,
    [
      "scope",
      "productBinding",
      "enforcement",
      "epochFormat",
      "firebaseGlobalRevocationAllowed",
      "researchSessionRevocationAllowed",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The Hushh Tech re-login contract has unexpected fields."
  );
  if (
    contract.relogin.scope !== "HUSHH_TECH_PRODUCT_ONLY" ||
    contract.relogin.productBinding !== "hushh-tech" ||
    contract.relogin.enforcement !== "SERVER_AUTH_TIME_CUTOFF" ||
    contract.relogin.epochFormat !== "RFC3339_UTC_SECONDS" ||
    contract.relogin.firebaseGlobalRevocationAllowed !== false ||
    contract.relogin.researchSessionRevocationAllowed !== false
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The product-local re-login boundary changed."
    );
  }
  exactKeys(
    contract.calendarReconnect,
    [
      "evidenceContents",
      "requiredUserRows",
      "reconnectAction",
      "nonReconnectAction",
      "googleRefreshTokenMigration",
      "identityRowsRepositoryStorage",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The calendar reconnect contract has unexpected fields."
  );
  if (
    contract.calendarReconnect.evidenceContents !==
      "SANITIZED_RECONNECT_FLAGS_ONLY" ||
    contract.calendarReconnect.requiredUserRows !== expected.authUsers ||
    contract.calendarReconnect.reconnectAction !== "RECONNECT_ONCE" ||
    contract.calendarReconnect.nonReconnectAction !== "NOT_REQUIRED" ||
    contract.calendarReconnect.googleRefreshTokenMigration !== "FORBIDDEN" ||
    contract.calendarReconnect.identityRowsRepositoryStorage !== "FORBIDDEN"
  ) {
    fail(
      "INVALID_FIREBASE_DRY_RUN_CONTRACT",
      "The calendar reconnect boundary changed."
    );
  }
  const schema = contract.firebaseAdminImportSchema;
  exactKeys(
    schema,
    [
      "call",
      "batchAllowedKeys",
      "recordRequiredKeys",
      "recordOptionalKeys",
      "providerRecordAllowedKeys",
      "bcryptImportOptions",
      "protectedRuntimeOnlyFields",
      "forbiddenFields",
      "repositoryPayloadStorage",
    ],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The Firebase import payload schema has unexpected fields."
  );
  exactArray(
    schema.batchAllowedKeys,
    ["users", "options"],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The Firebase import batch schema changed."
  );
  exactArray(
    schema.recordRequiredKeys,
    ["uid", "emailVerified", "disabled"],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The Firebase import record required fields changed."
  );
  exactArray(
    schema.recordOptionalKeys,
    [
      "email",
      "displayName",
      "photoURL",
      "phoneNumber",
      "metadata",
      "providerData",
      "passwordHash",
    ],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The Firebase import record optional fields changed."
  );
  exactArray(
    schema.providerRecordAllowedKeys,
    ["uid", "providerId", "email", "displayName", "photoURL", "phoneNumber"],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The Firebase provider record schema changed."
  );
  if (
    canonicalJson(schema.bcryptImportOptions) !==
      canonicalJson({ hash: { algorithm: "BCRYPT" } }) ||
    schema.repositoryPayloadStorage !== "FORBIDDEN"
  ) {
    fail(
      "INVALID_FIREBASE_IMPORT_SCHEMA",
      "The Firebase bcrypt or repository payload policy changed."
    );
  }
  exactArray(
    schema.protectedRuntimeOnlyFields,
    [
      "email",
      "displayName",
      "photoURL",
      "phoneNumber",
      "metadata",
      "providerData",
      "passwordHash",
    ],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The protected Firebase import field list changed."
  );
  exactArray(
    schema.forbiddenFields,
    [
      "customClaims",
      "passwordSalt",
      "refreshToken",
      "accessToken",
      "sessionToken",
      "otp",
      "magicLink",
    ],
    "INVALID_FIREBASE_IMPORT_SCHEMA",
    "The forbidden Firebase import field list changed."
  );
  exactKeys(
    contract.checkpointEvidenceSchema,
    ["requiredKeys", "hashAlgorithm", "writeMode"],
    "INVALID_FIREBASE_CHECKPOINT_SCHEMA",
    "The checkpoint evidence schema has unexpected fields."
  );
  exactArray(
    contract.checkpointEvidenceSchema.requiredKeys,
    [
      "replayKey",
      "stream",
      "sequence",
      "cursor",
      "rowCount",
      "batchHash",
      "previousCheckpointHash",
      "checkpointHash",
    ],
    "INVALID_FIREBASE_CHECKPOINT_SCHEMA",
    "The checkpoint evidence schema changed."
  );
  if (
    contract.checkpointEvidenceSchema.hashAlgorithm !==
      "sha256_canonical_json_v1" ||
    contract.checkpointEvidenceSchema.writeMode !== "APPEND_ONLY_CREATE"
  ) {
    fail(
      "INVALID_FIREBASE_CHECKPOINT_SCHEMA",
      "The checkpoint integrity policy changed."
    );
  }
  exactKeys(
    contract.rollbackEvidenceSchema,
    [
      "requiredKeys",
      "hashAlgorithm",
      "existingLinkedUsersDeletion",
      "createdUsersDeletion",
      "dryRunRollback",
      "repositoryStorage",
    ],
    "INVALID_FIREBASE_ROLLBACK_SCHEMA",
    "The rollback evidence schema has unexpected fields."
  );
  exactArray(
    contract.rollbackEvidenceSchema.requiredKeys,
    [
      "replayKey",
      "authorityBindingHash",
      "mappingInputHash",
      "createdFirebaseUidHashes",
      "preexistingFirebaseUidHashes",
      "batchCheckpointHashes",
      "recordedAt",
    ],
    "INVALID_FIREBASE_ROLLBACK_SCHEMA",
    "The rollback evidence schema changed."
  );
  if (
    contract.rollbackEvidenceSchema.hashAlgorithm !==
      "sha256_canonical_json_v1" ||
    contract.rollbackEvidenceSchema.existingLinkedUsersDeletion !== "FORBIDDEN" ||
    contract.rollbackEvidenceSchema.createdUsersDeletion !==
      "FORBIDDEN_IN_DRY_RUN" ||
    contract.rollbackEvidenceSchema.dryRunRollback !==
      "NO_MUTATIONS_TO_ROLL_BACK" ||
    contract.rollbackEvidenceSchema.repositoryStorage !== "HASHES_AND_COUNTS_ONLY"
  ) {
    fail(
      "INVALID_FIREBASE_ROLLBACK_SCHEMA",
      "The rollback safety policy changed."
    );
  }
  exactKeys(
    contract.futureExecutorGates,
    [
      "freshFirebaseAuthorityRead",
      "uidCollisionCheck",
      "providerOwnershipCheck",
      "maximumEvidenceAgeSeconds",
      "satisfiedByDryRun",
    ],
    "INVALID_FIREBASE_EXECUTOR_GATES",
    "The future Firebase executor gates have unexpected fields."
  );
  if (
    contract.futureExecutorGates.freshFirebaseAuthorityRead !== "REQUIRED" ||
    contract.futureExecutorGates.uidCollisionCheck !==
      "REQUIRED_IMMEDIATELY_BEFORE_EACH_BATCH" ||
    contract.futureExecutorGates.providerOwnershipCheck !==
      "REQUIRED_IMMEDIATELY_BEFORE_EACH_BATCH" ||
    contract.futureExecutorGates.maximumEvidenceAgeSeconds !== 300 ||
    contract.futureExecutorGates.satisfiedByDryRun !== false
  ) {
    fail(
      "INVALID_FIREBASE_EXECUTOR_GATES",
      "Fresh live UID and provider collision checks must remain a hard future executor gate."
    );
  }
  exactArray(
    contract.blockers,
    [
      "DRY_RUN_ONLY",
      "PROTECTED_IMPORT_VALUES_NOT_PRESENT",
      "LIVE_FIREBASE_IMPORT_EXECUTOR_ABSENT",
      "FRESH_LIVE_UID_COLLISION_PREFLIGHT_REQUIRED",
      "CUTOVER_APPROVAL_REQUIRED",
    ],
    "INVALID_FIREBASE_DRY_RUN_CONTRACT",
    "The execution blockers changed."
  );
  return deepFreeze(contract);
}

export function assertAuthorityBinding(authority) {
  exactKeys(
    authority,
    ["projectId", "tenantId", "issuer", "audience", "productId"],
    "FIREBASE_AUTHORITY_BINDING_MISMATCH",
    "Firebase authority binding must use the exact Hushh Research envelope."
  );
  if (
    authority.projectId !== "hushh-pda" ||
    authority.tenantId !== null ||
    authority.issuer !== "https://securetoken.google.com/hushh-pda" ||
    authority.audience !== "hushh-pda" ||
    authority.productId !== "hushh-tech"
  ) {
    fail(
      "FIREBASE_AUTHORITY_BINDING_MISMATCH",
      "Firebase issuer, audience, tenant, or product binding is not authorized."
    );
  }
  return true;
}

export const FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT = validateFrozenContract(
  SOURCE_CONTRACT.firebaseIdentityImportDryRunContract
);

function lockedBoundary(boundary) {
  if (!boundary || boundary.mode !== "DRY_RUN") {
    fail("INVALID_MIGRATION_BOUNDARY", "A locked dry-run migration boundary is required.");
  }
  return assertMigrationBoundary({
    environment: boundary.environment,
    sourceProjectRef: boundary.source?.projectRef,
    sourceDatabase: boundary.source?.database,
    targetProject: boundary.target?.projectId,
    targetRegion: boundary.target?.region,
    targetInstance: boundary.target?.instance,
    targetDatabase: boundary.target?.database,
    postgresMajor: boundary.target?.postgresMajor,
    dryRun: true,
  });
}

function normalizeReloginEpoch(value) {
  if (!RFC3339_UTC_SECONDS_PATTERN.test(value ?? "")) {
    fail(
      "INVALID_RELOGIN_EPOCH",
      "The product-local re-login epoch must be RFC3339 UTC at whole-second precision."
    );
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(
      "INVALID_RELOGIN_EPOCH",
      "The product-local re-login epoch is not a real UTC timestamp."
    );
  }
  return value;
}

function buildReloginPolicy(epochInput) {
  const epoch = normalizeReloginEpoch(epochInput);
  const frozen = FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.relogin;
  return Object.freeze({
    scope: frozen.scope,
    productBinding: frozen.productBinding,
    enforcement: frozen.enforcement,
    epoch,
    firebaseGlobalRevocationAllowed: false,
    researchSessionRevocationAllowed: false,
  });
}

function validateReloginPolicy(policy) {
  exactKeys(
    policy,
    [
      "scope",
      "productBinding",
      "enforcement",
      "epoch",
      "firebaseGlobalRevocationAllowed",
      "researchSessionRevocationAllowed",
    ],
    "INVALID_RELOGIN_POLICY",
    "The product-local re-login policy has unexpected fields."
  );
  const frozen = FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.relogin;
  if (
    policy.scope !== frozen.scope ||
    policy.productBinding !== frozen.productBinding ||
    policy.enforcement !== frozen.enforcement ||
    normalizeReloginEpoch(policy.epoch) !== policy.epoch ||
    policy.firebaseGlobalRevocationAllowed !== false ||
    policy.researchSessionRevocationAllowed !== false
  ) {
    fail(
      "INVALID_RELOGIN_POLICY",
      "Re-login must remain Hushh Tech-local without global Firebase or Research revocation."
    );
  }
  return canonicalHash(policy);
}

function buildRollbackPolicy(createdUidCandidateCount, evidenceSchemaHash) {
  return Object.freeze({
    mode: "DRY_RUN_NO_MUTATION",
    createdUidCandidateCount,
    existingLinkedUidDeletionAllowed: false,
    createdUidDeletionAllowed: false,
    evidenceSchemaHash,
    evidenceWriteMode: "UNAVAILABLE_IN_DRY_RUN",
  });
}

function validateRollbackPolicy(policy, expectedCreatedCount, evidenceSchemaHash) {
  exactKeys(
    policy,
    [
      "mode",
      "createdUidCandidateCount",
      "existingLinkedUidDeletionAllowed",
      "createdUidDeletionAllowed",
      "evidenceSchemaHash",
      "evidenceWriteMode",
    ],
    "INVALID_ROLLBACK_POLICY",
    "The dry-run rollback policy has unexpected fields."
  );
  if (
    policy.mode !== "DRY_RUN_NO_MUTATION" ||
    policy.createdUidCandidateCount !== expectedCreatedCount ||
    policy.existingLinkedUidDeletionAllowed !== false ||
    policy.createdUidDeletionAllowed !== false ||
    policy.evidenceSchemaHash !== evidenceSchemaHash ||
    policy.evidenceWriteMode !== "UNAVAILABLE_IN_DRY_RUN"
  ) {
    fail(
      "INVALID_ROLLBACK_POLICY",
      "The dry-run planner has no Firebase deletion or rollback write authority."
    );
  }
  return canonicalHash(policy);
}

function buildFutureExecutorGates() {
  const frozen = FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.futureExecutorGates;
  return Object.freeze({
    freshFirebaseAuthorityRead: frozen.freshFirebaseAuthorityRead,
    uidCollisionCheck: frozen.uidCollisionCheck,
    providerOwnershipCheck: frozen.providerOwnershipCheck,
    maximumEvidenceAgeSeconds: frozen.maximumEvidenceAgeSeconds,
    satisfiedByDryRun: false,
  });
}

function validateFutureExecutorGates(gates) {
  exactKeys(
    gates,
    [
      "freshFirebaseAuthorityRead",
      "uidCollisionCheck",
      "providerOwnershipCheck",
      "maximumEvidenceAgeSeconds",
      "satisfiedByDryRun",
    ],
    "INVALID_FIREBASE_EXECUTOR_GATES",
    "The future Firebase executor gate plan has unexpected fields."
  );
  if (
    canonicalJson(gates) !==
    canonicalJson(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.futureExecutorGates)
  ) {
    fail(
      "INVALID_FIREBASE_EXECUTOR_GATES",
      "Fresh live UID and provider ownership checks must remain unsatisfied in dry run."
    );
  }
  return canonicalHash(gates);
}

function providerKey(provider) {
  if (
    !provider ||
    typeof provider.providerId !== "string" ||
    !FIREBASE_PROVIDER_ID_PATTERN.test(provider.providerId) ||
    typeof provider.subject !== "string" ||
    provider.subject.length === 0 ||
    provider.subject.length > 512 ||
    provider.subject.includes("\u0000")
  ) {
    fail(
      "INVALID_FIREBASE_PROVIDER_SUBJECT",
      "Firebase provider evidence requires a bounded immutable subject."
    );
  }
  const providerId = provider.providerId.toLowerCase().normalize("NFC");
  if (EMAIL_PROVIDER_IDS.has(providerId)) {
    fail(
      "EMAIL_EVIDENCE_FORBIDDEN",
      "Email provider data cannot participate in identity matching."
    );
  }
  return `${providerId}\u0000${provider.subject.normalize("NFC")}`;
}

function providerEvidenceHash(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function validateFirebaseAuthorityIndex(firebaseAuthority) {
  exactKeys(
    firebaseAuthority,
    ["projectId", "tenantId", "users"],
    "FIREBASE_AUTHORITY_MISMATCH",
    "Firebase provider evidence must use the tenantless hushh-pda envelope."
  );
  if (
    firebaseAuthority.projectId !== "hushh-pda" ||
    firebaseAuthority.tenantId !== null ||
    !Array.isArray(firebaseAuthority.users)
  ) {
    fail(
      "FIREBASE_AUTHORITY_MISMATCH",
      "Firebase provider evidence must use the tenantless hushh-pda envelope."
    );
  }
  const firebaseUids = new Set();
  const providerOwners = new Map();
  const providerEvidenceOwners = new Map();
  const normalizedUsers = [];
  for (const user of firebaseAuthority.users) {
    if (
      !user ||
      typeof user.firebaseUid !== "string" ||
      user.firebaseUid.length === 0 ||
      user.firebaseUid.length > 128 ||
      !Array.isArray(user.providerSubjects)
    ) {
      fail("INVALID_FIREBASE_USER", "Firebase authority users require a bounded UID.");
    }
    if (firebaseUids.has(user.firebaseUid)) {
      fail("DUPLICATE_FIREBASE_UID", "Firebase authority contains a duplicate UID.");
    }
    firebaseUids.add(user.firebaseUid);
    const providerKeys = user.providerSubjects.map(providerKey).sort();
    if (new Set(providerKeys).size !== providerKeys.length) {
      fail(
        "DUPLICATE_FIREBASE_PROVIDER_SUBJECT",
        "A Firebase identity repeats immutable provider evidence."
      );
    }
    for (const key of providerKeys) {
      if (providerOwners.has(key)) {
        fail(
          "DUPLICATE_FIREBASE_PROVIDER_SUBJECT",
          "One immutable provider subject cannot belong to multiple Firebase identities."
        );
      }
      providerOwners.set(key, user.firebaseUid);
      const evidenceHash = providerEvidenceHash(key);
      if (providerEvidenceOwners.has(evidenceHash)) {
        fail(
          "DUPLICATE_FIREBASE_PROVIDER_SUBJECT",
          "Firebase provider evidence produced a duplicate global fingerprint."
        );
      }
      providerEvidenceOwners.set(evidenceHash, user.firebaseUid);
    }
    normalizedUsers.push({
      firebaseUid: user.firebaseUid,
      providerKeys,
    });
  }
  normalizedUsers.sort((left, right) =>
    left.firebaseUid < right.firebaseUid
      ? -1
      : left.firebaseUid > right.firebaseUid
        ? 1
        : 0
  );
  return Object.freeze({
    firebaseUids,
    providerEvidenceOwners,
    authorityIndexHash: canonicalHash({
      projectId: firebaseAuthority.projectId,
      tenantId: firebaseAuthority.tenantId,
      users: normalizedUsers,
    }),
  });
}

function validateCalendarEvidence(calendarEvidence, authMappings) {
  exactKeys(
    calendarEvidence,
    ["version", "sourceProjectRef", "contents", "users"],
    "INVALID_CALENDAR_EVIDENCE",
    "Calendar reconnect evidence has unexpected fields."
  );
  if (
    calendarEvidence.version !== 1 ||
    calendarEvidence.sourceProjectRef !== SOURCE_CONTRACT.source.projectRef ||
    calendarEvidence.contents !== "SANITIZED_RECONNECT_FLAGS_ONLY" ||
    !Array.isArray(calendarEvidence.users) ||
    calendarEvidence.users.length !== SOURCE_CONTRACT.expected.authUsers
  ) {
    fail(
      "INVALID_CALENDAR_EVIDENCE",
      "Calendar reconnect evidence must cover exactly 369 source Auth identities."
    );
  }
  const expectedLegacyUuids = new Set(
    authMappings.map(({ legacyUserUuid }) => legacyUserUuid.toLowerCase())
  );
  const reconnectByLegacyUuid = new Map();
  for (const user of calendarEvidence.users) {
    exactKeys(
      user,
      ["legacyUserUuid", "reconnectRequired"],
      "INVALID_CALENDAR_EVIDENCE",
      "A calendar reconnect row has unexpected fields."
    );
    const legacyUserUuid = user.legacyUserUuid?.toLowerCase();
    if (
      !UUID_PATTERN.test(legacyUserUuid ?? "") ||
      typeof user.reconnectRequired !== "boolean" ||
      reconnectByLegacyUuid.has(legacyUserUuid)
    ) {
      fail(
        "INVALID_CALENDAR_EVIDENCE",
        "Calendar reconnect rows require unique legacy UUIDs and boolean flags."
      );
    }
    if (!expectedLegacyUuids.has(legacyUserUuid)) {
      fail(
        "CALENDAR_IDENTITY_SET_MISMATCH",
        "Calendar reconnect evidence includes a non-Auth legacy identity."
      );
    }
    reconnectByLegacyUuid.set(legacyUserUuid, user.reconnectRequired);
  }
  if (
    reconnectByLegacyUuid.size !== expectedLegacyUuids.size ||
    [...expectedLegacyUuids].some((legacyUserUuid) =>
      !reconnectByLegacyUuid.has(legacyUserUuid)
    )
  ) {
    fail(
      "CALENDAR_IDENTITY_SET_MISMATCH",
      "Calendar reconnect evidence must match the exact 369 Auth identity set."
    );
  }
  const normalizedRows = [...reconnectByLegacyUuid.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([legacyUserUuid, reconnectRequired]) => ({
      legacyUserUuid,
      reconnectRequired,
    }));
  return Object.freeze({
    reconnectByLegacyUuid,
    evidenceHash: canonicalHash({
      version: calendarEvidence.version,
      sourceProjectRef: calendarEvidence.sourceProjectRef,
      contents: calendarEvidence.contents,
      users: normalizedRows,
    }),
    reconnectRequiredCount: normalizedRows.filter(({ reconnectRequired }) =>
      reconnectRequired
    ).length,
  });
}

function hashLegacyUuid(legacyUserUuid) {
  return canonicalHash({
    sourceProjectRef: SOURCE_CONTRACT.source.projectRef,
    legacyUserUuid: legacyUserUuid.toLowerCase(),
  });
}

function hashFirebaseUid(firebaseUid) {
  return canonicalHash({
    authorityProjectId: "hushh-pda",
    firebaseUid,
  });
}

function withRecordHash(record) {
  return Object.freeze({
    ...record,
    recordHash: canonicalHash(record),
  });
}

function buildDispositionRecord(mapping, reconnectRequired) {
  return withRecordHash({
    legacyUserKey: hashLegacyUuid(mapping.legacyUserUuid),
    firebaseUidHash: mapping.firebaseUid ? hashFirebaseUid(mapping.firebaseUid) : null,
    terminalDisposition: mapping.status,
    mappingBasis: mapping.mappingBasis,
    providerEvidenceHashes: [...mapping.providerEvidenceHashes],
    emailWasUsed: false,
    accessAllowed: mapping.accessAllowed,
    calendarReconnectAction: reconnectRequired ? "RECONNECT_ONCE" : "NOT_REQUIRED",
  });
}

function buildImportRecord(mapping, reconnectRequired) {
  const emailField = mapping.emailPresent
    ? "PROTECTED_RUNTIME_VALUE_REQUIRED"
    : "OMIT";
  const providerDataField = mapping.providerEvidenceHashes.length > 0
    ? "PROTECTED_RUNTIME_VALUE_REQUIRED"
    : "OMIT";
  const passwordHashField = mapping.passwordAction === "IMPORT_BCRYPT"
    ? "PROTECTED_BCRYPT_BYTES_REQUIRED"
    : "OMIT";
  return withRecordHash({
    legacyUserKey: hashLegacyUuid(mapping.legacyUserUuid),
    firebaseUidHash: hashFirebaseUid(mapping.firebaseUid),
    terminalDisposition: mapping.status,
    mappingBasis: mapping.mappingBasis,
    providerEvidenceHashes: [...mapping.providerEvidenceHashes],
    emailWasUsed: false,
    appleWithoutEmail: mapping.appleNoEmail,
    emailSignInUser: mapping.isEmailPasswordUser,
    bcryptAction: mapping.passwordAction,
    calendarReconnectAction: reconnectRequired ? "RECONNECT_ONCE" : "NOT_REQUIRED",
    payloadFieldPlan: {
      uid: "DETERMINISTIC_UID_REQUIRED",
      email: emailField,
      emailVerified: mapping.emailPresent
        ? "PROTECTED_RUNTIME_BOOLEAN_REQUIRED"
        : "EXPLICIT_FALSE",
      disabled: "PROTECTED_RUNTIME_BOOLEAN_REQUIRED",
      displayName: "PROTECTED_RUNTIME_VALUE_OPTIONAL",
      photoURL: "PROTECTED_RUNTIME_VALUE_OPTIONAL",
      phoneNumber: "PROTECTED_RUNTIME_VALUE_OPTIONAL",
      metadata: "PROTECTED_RUNTIME_VALUE_OPTIONAL",
      providerData: providerDataField,
      passwordHash: passwordHashField,
    },
  });
}

function buildUnclaimedRecord(mapping) {
  return withRecordHash({
    legacyUserKey: hashLegacyUuid(mapping.legacyUserUuid),
    firebaseUidHash: null,
    status: "UNCLAIMED_LEGACY_PRINCIPAL",
    accessAllowed: false,
    firebaseImportAllowed: false,
  });
}

function buildCheckpointBatches({ records, batchSize, replayKey, stream }) {
  const batches = [];
  let previousCheckpoint = null;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batchRecords = records.slice(offset, offset + batchSize);
    const sequence = batches.length;
    const checkpoint = createCheckpoint({
      replayKey,
      stream,
      sequence,
      cursor: { lastRecordHash: batchRecords.at(-1).recordHash },
      rowHashes: batchRecords.map(({ recordHash }) => recordHash),
      previousCheckpointHash: previousCheckpoint?.checkpointHash ?? null,
    });
    assertCheckpointIntegrity(checkpoint);
    if (previousCheckpoint) {
      assertCheckpointContinuation(previousCheckpoint, checkpoint);
    }
    const bcryptRecordCount = batchRecords.filter(
      ({ bcryptAction }) => bcryptAction === "IMPORT_BCRYPT"
    ).length;
    batches.push(
      Object.freeze({
        ...checkpoint,
        idempotencyKey: canonicalHash({
          replayKey,
          stream,
          sequence,
          batchHash: checkpoint.batchHash,
        }),
        bcryptRecordCount,
        importOptions:
          bcryptRecordCount > 0
            ? Object.freeze({ hashAlgorithm: "BCRYPT" })
            : Object.freeze({ hashAlgorithm: null }),
      })
    );
    previousCheckpoint = checkpoint;
  }
  return Object.freeze(batches);
}

function assertRecordHashes(records, label) {
  const recordHashes = new Set();
  for (const record of records) {
    if (!SHA256_PATTERN.test(record.recordHash ?? "")) {
      fail("INVALID_FIREBASE_PLAN_RECORD", `${label} contains an invalid record hash.`);
    }
    const { recordHash, ...payload } = record;
    if (canonicalHash(payload) !== recordHash) {
      fail("FIREBASE_PLAN_INTEGRITY_FAILURE", `${label} record content was modified.`);
    }
    if (recordHashes.has(recordHash)) {
      fail("DUPLICATE_FIREBASE_PLAN_RECORD", `${label} repeats a record hash.`);
    }
    recordHashes.add(recordHash);
  }
}

function validateImportRecordFields(record) {
  exactKeys(
    record.payloadFieldPlan,
    [
      "uid",
      "email",
      "emailVerified",
      "disabled",
      "displayName",
      "photoURL",
      "phoneNumber",
      "metadata",
      "providerData",
      "passwordHash",
    ],
    "INVALID_FIREBASE_PLAN_RECORD",
    "A Firebase import field plan has unexpected fields."
  );
  const fields = record.payloadFieldPlan;
  if (
    fields.uid !== "DETERMINISTIC_UID_REQUIRED" ||
    !["PROTECTED_RUNTIME_VALUE_REQUIRED", "OMIT"].includes(fields.email) ||
    !["PROTECTED_RUNTIME_BOOLEAN_REQUIRED", "EXPLICIT_FALSE"].includes(
      fields.emailVerified
    ) ||
    fields.disabled !== "PROTECTED_RUNTIME_BOOLEAN_REQUIRED" ||
    fields.displayName !== "PROTECTED_RUNTIME_VALUE_OPTIONAL" ||
    fields.photoURL !== "PROTECTED_RUNTIME_VALUE_OPTIONAL" ||
    fields.phoneNumber !== "PROTECTED_RUNTIME_VALUE_OPTIONAL" ||
    fields.metadata !== "PROTECTED_RUNTIME_VALUE_OPTIONAL" ||
    !["PROTECTED_RUNTIME_VALUE_REQUIRED", "OMIT"].includes(fields.providerData) ||
    !["PROTECTED_BCRYPT_BYTES_REQUIRED", "OMIT"].includes(fields.passwordHash)
  ) {
    fail(
      "INVALID_FIREBASE_PLAN_RECORD",
      "A Firebase import field plan weakens protected runtime value handling."
    );
  }
  if (
    (fields.email === "OMIT" && fields.emailVerified !== "EXPLICIT_FALSE") ||
    (fields.email !== "OMIT" &&
      fields.emailVerified !== "PROTECTED_RUNTIME_BOOLEAN_REQUIRED")
  ) {
    fail(
      "INVALID_FIREBASE_PLAN_RECORD",
      "Email confirmation planning must match protected email presence."
    );
  }
  if (record.emailSignInUser) {
    if (
      record.mappingBasis !== "LEGACY_UUID" ||
      record.providerEvidenceHashes.length !== 0 ||
      fields.email !== "PROTECTED_RUNTIME_VALUE_REQUIRED" ||
      fields.providerData !== "OMIT" ||
      !["IMPORT_BCRYPT", "PASSWORD_SETUP_REQUIRED"].includes(record.bcryptAction) ||
      (record.bcryptAction === "IMPORT_BCRYPT" &&
        fields.passwordHash !== "PROTECTED_BCRYPT_BYTES_REQUIRED") ||
      (record.bcryptAction === "PASSWORD_SETUP_REQUIRED" &&
        fields.passwordHash !== "OMIT")
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "Email sign-in import planning cannot use email as an identity key."
      );
    }
  } else if (
    record.mappingBasis !== "PROVIDER_SUBJECT" ||
    record.providerEvidenceHashes.length === 0 ||
    record.bcryptAction !== "NOT_APPLICABLE" ||
    fields.providerData !== "PROTECTED_RUNTIME_VALUE_REQUIRED" ||
    fields.passwordHash !== "OMIT"
  ) {
    fail(
      "INVALID_FIREBASE_PLAN_RECORD",
      "Provider-backed imports require immutable provider evidence only."
    );
  }
  if (
    record.appleWithoutEmail &&
    (record.emailSignInUser ||
      fields.email !== "OMIT" ||
      fields.providerData !== "PROTECTED_RUNTIME_VALUE_REQUIRED")
  ) {
    fail(
      "INVALID_FIREBASE_PLAN_RECORD",
      "Apple imports without email must remain separate provider-subject identities."
    );
  }
}

function expectedPlanInputHash(plan) {
  return canonicalHash({
    version: 1,
    sourceInventoryHash: plan.sourceInventoryHash,
    mappingInputHash: plan.mappingInputHash,
    mappingOutputHash: plan.mappingOutputHash,
    authorityBindingHash: plan.authorityBindingHash,
    authorityIndexHash: plan.authorityIndexHash,
    calendarEvidenceHash: plan.calendarEvidenceHash,
    reloginPolicyHash: plan.reloginPolicyHash,
    rollbackPolicyHash: plan.rollbackPolicyHash,
    futureExecutorGatesHash: plan.futureExecutorGatesHash,
    policyContractHash: plan.policyContractHash,
    payloadSchemaHash: plan.payloadSchemaHash,
  });
}

export function validateFirebaseIdentityImportDryRunPlan(plan) {
  if (!plan || plan.version !== 1 || plan.mode !== "DRY_RUN") {
    fail("INVALID_FIREBASE_DRY_RUN_PLAN", "Firebase identity dry-run plan version 1 is required.");
  }
  if (plan.executionEnabled !== false || plan.applyReady !== false) {
    fail("EXECUTION_FORBIDDEN", "Firebase identity imports must remain execution-disabled.");
  }
  const normalizedBoundary = lockedBoundary(plan.boundary);
  if (canonicalJson(normalizedBoundary) !== canonicalJson(plan.boundary)) {
    fail(
      "INVALID_MIGRATION_BOUNDARY",
      "Firebase identity plan boundary contains unreviewed fields."
    );
  }
  assertAuthorityBinding(plan.authority);
  const lockedCounts = FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.lockedDispositions;
  const expectedRollbackEvidenceSchemaHash = canonicalHash(
    FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.rollbackEvidenceSchema
  );
  const calculatedReloginPolicyHash = validateReloginPolicy(plan.relogin);
  const calculatedRollbackPolicyHash = validateRollbackPolicy(
    plan.rollback,
    lockedCounts.importedFirebase,
    expectedRollbackEvidenceSchemaHash
  );
  const calculatedFutureExecutorGatesHash = validateFutureExecutorGates(
    plan.futureExecutorGates
  );
  if (
    plan.policyContractHash !==
      SOURCE_CONTRACT.firebaseIdentityImportDryRunContractHash ||
    plan.payloadSchemaHash !==
      canonicalHash(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.firebaseAdminImportSchema) ||
    plan.rollbackEvidenceSchemaHash !==
      expectedRollbackEvidenceSchemaHash ||
    plan.authorityBindingHash !== canonicalHash(plan.authority) ||
    plan.reloginPolicyHash !== calculatedReloginPolicyHash ||
    plan.rollbackPolicyHash !== calculatedRollbackPolicyHash ||
    plan.futureExecutorGatesHash !== calculatedFutureExecutorGatesHash
  ) {
    fail(
      "FIREBASE_PLAN_CONTRACT_MISMATCH",
      "Firebase identity dry-run plan is not bound to the reviewed contracts."
    );
  }
  for (const value of [
    plan.sourceInventoryHash,
    plan.mappingInputHash,
    plan.mappingOutputHash,
    plan.authorityIndexHash,
    plan.calendarEvidenceHash,
    plan.reloginPolicyHash,
    plan.rollbackPolicyHash,
    plan.futureExecutorGatesHash,
    plan.planInputHash,
    plan.replayKey,
  ]) {
    if (!SHA256_PATTERN.test(value ?? "")) {
      fail("INVALID_FIREBASE_PLAN_HASH", "Firebase dry-run evidence requires SHA-256 hashes.");
    }
  }
  if (expectedPlanInputHash(plan) !== plan.planInputHash) {
    fail("FIREBASE_PLAN_INTEGRITY_FAILURE", "Firebase dry-run input binding was modified.");
  }
  const run = createMigrationRunPlan({
    sourceInventoryHash: plan.sourceInventoryHash,
    mappingInputHash: plan.planInputHash,
    target: plan.boundary.target,
    dryRun: true,
  });
  if (run.replayKey !== plan.replayKey) {
    fail("FIREBASE_PLAN_INTEGRITY_FAILURE", "Firebase dry-run replay key was modified.");
  }
  exactKeys(
    plan.counts,
    [
      "authTerminalCount",
      "linkedExistingFirebase",
      "importedFirebase",
      "manualRecovery",
      "legallyRetainedNoLogin",
      "intentionallyDeleted",
      "appleWithoutEmail",
      "emailSignInUsers",
      "emailOnlyLinks",
      "unclaimedLegacyPrincipals",
      "firebaseImportRecords",
      "bcryptMetadataUsers",
      "setupRequiredUsers",
      "calendarReconnectUsers",
    ],
    "INVALID_FIREBASE_PLAN_COUNTS",
    "Firebase identity count evidence has unexpected fields."
  );
  if (
    plan.counts.authTerminalCount !== lockedCounts.authUsers ||
    plan.counts.linkedExistingFirebase !== lockedCounts.linkedExistingFirebase ||
    plan.counts.importedFirebase !== lockedCounts.importedFirebase ||
    plan.counts.appleWithoutEmail !== lockedCounts.appleWithoutEmail ||
    plan.counts.emailSignInUsers !== lockedCounts.emailSignInUsers ||
    plan.counts.unclaimedLegacyPrincipals !== lockedCounts.unclaimedLegacyPrincipals ||
    plan.counts.emailOnlyLinks !== 0 ||
    plan.counts.manualRecovery !== 0 ||
    plan.counts.legallyRetainedNoLogin !== 0 ||
    plan.counts.intentionallyDeleted !== 0 ||
    plan.counts.firebaseImportRecords !== lockedCounts.importedFirebase ||
    plan.counts.bcryptMetadataUsers + plan.counts.setupRequiredUsers !==
      lockedCounts.emailSignInUsers ||
    !Number.isSafeInteger(plan.counts.calendarReconnectUsers) ||
    plan.counts.calendarReconnectUsers < 0 ||
    plan.counts.calendarReconnectUsers > lockedCounts.authUsers
  ) {
    fail(
      "LOCKED_BASELINE_MISMATCH",
      "Firebase identity plan does not match the frozen 165/204/3/4/65 baseline."
    );
  }
  if (
    plan.dispositionRecords.length !== lockedCounts.authUsers ||
    plan.firebaseImportRecords.length !== lockedCounts.importedFirebase ||
    plan.unclaimedRecords.length !== lockedCounts.unclaimedLegacyPrincipals
  ) {
    fail("FIREBASE_PLAN_COUNT_MISMATCH", "Firebase plan record arrays are incomplete.");
  }
  assertRecordHashes(plan.dispositionRecords, "Disposition plan");
  assertRecordHashes(plan.firebaseImportRecords, "Firebase import plan");
  assertRecordHashes(plan.unclaimedRecords, "Unclaimed principal plan");
  const dispositionByLegacyKey = new Map();
  const activeUidHashes = new Set();
  const providerEvidenceHashes = new Set();
  const calculatedDispositionCounts = {
    linkedExistingFirebase: 0,
    importedFirebase: 0,
    calendarReconnectUsers: 0,
  };
  for (const record of plan.dispositionRecords) {
    exactKeys(
      record,
      [
        "legacyUserKey",
        "firebaseUidHash",
        "terminalDisposition",
        "mappingBasis",
        "providerEvidenceHashes",
        "emailWasUsed",
        "accessAllowed",
        "calendarReconnectAction",
        "recordHash",
      ],
      "INVALID_FIREBASE_PLAN_RECORD",
      "A Firebase disposition record has unexpected fields."
    );
    if (
      !SHA256_PATTERN.test(record.legacyUserKey ?? "") ||
      !SHA256_PATTERN.test(record.firebaseUidHash ?? "") ||
      record.emailWasUsed !== false ||
      record.accessAllowed !== true ||
      !["RECONNECT_ONCE", "NOT_REQUIRED"].includes(
        record.calendarReconnectAction
      ) ||
      dispositionByLegacyKey.has(record.legacyUserKey) ||
      activeUidHashes.has(record.firebaseUidHash) ||
      !Array.isArray(record.providerEvidenceHashes) ||
      record.providerEvidenceHashes.some((hash) => !SHA256_PATTERN.test(hash))
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "A Firebase disposition record violates identity uniqueness or access rules."
      );
    }
    if (
      record.terminalDisposition === "LINKED_EXISTING_FIREBASE" &&
      (record.mappingBasis !== "PROVIDER_SUBJECT" ||
        record.providerEvidenceHashes.length === 0)
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "Existing Firebase links require immutable provider-subject evidence."
      );
    } else if (
      record.terminalDisposition === "IMPORTED_FIREBASE" &&
      !["PROVIDER_SUBJECT", "LEGACY_UUID"].includes(record.mappingBasis)
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "New Firebase identities require provider-subject or legacy UUID provenance."
      );
    } else if (
      !["LINKED_EXISTING_FIREBASE", "IMPORTED_FIREBASE"].includes(
        record.terminalDisposition
      )
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "The locked Firebase plan cannot contain a non-active Auth disposition."
      );
    }
    for (const hash of record.providerEvidenceHashes) {
      if (providerEvidenceHashes.has(hash)) {
        fail(
          "DUPLICATE_PROVIDER_EVIDENCE",
          "One immutable provider subject cannot own multiple dispositions."
        );
      }
      providerEvidenceHashes.add(hash);
    }
    dispositionByLegacyKey.set(record.legacyUserKey, record);
    activeUidHashes.add(record.firebaseUidHash);
    if (record.terminalDisposition === "LINKED_EXISTING_FIREBASE") {
      calculatedDispositionCounts.linkedExistingFirebase += 1;
    } else {
      calculatedDispositionCounts.importedFirebase += 1;
    }
    if (record.calendarReconnectAction === "RECONNECT_ONCE") {
      calculatedDispositionCounts.calendarReconnectUsers += 1;
    }
  }
  const importedByLegacyKey = new Map();
  let calculatedAppleWithoutEmail = 0;
  let calculatedEmailSignInUsers = 0;
  let calculatedBcryptMetadataUsers = 0;
  let calculatedSetupRequiredUsers = 0;
  for (const record of plan.firebaseImportRecords) {
    exactKeys(
      record,
      [
        "legacyUserKey",
        "firebaseUidHash",
        "terminalDisposition",
        "mappingBasis",
        "providerEvidenceHashes",
        "emailWasUsed",
        "appleWithoutEmail",
        "emailSignInUser",
        "bcryptAction",
        "calendarReconnectAction",
        "payloadFieldPlan",
        "recordHash",
      ],
      "INVALID_FIREBASE_PLAN_RECORD",
      "A Firebase import record has unexpected fields."
    );
    const disposition = dispositionByLegacyKey.get(record.legacyUserKey);
    if (
      record.terminalDisposition !== "IMPORTED_FIREBASE" ||
      record.emailWasUsed !== false ||
      typeof record.appleWithoutEmail !== "boolean" ||
      typeof record.emailSignInUser !== "boolean" ||
      !disposition ||
      disposition.terminalDisposition !== "IMPORTED_FIREBASE" ||
      disposition.firebaseUidHash !== record.firebaseUidHash ||
      disposition.mappingBasis !== record.mappingBasis ||
      disposition.calendarReconnectAction !== record.calendarReconnectAction ||
      canonicalJson(disposition.providerEvidenceHashes) !==
        canonicalJson(record.providerEvidenceHashes) ||
      importedByLegacyKey.has(record.legacyUserKey)
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "Firebase import records must exactly match imported dispositions."
      );
    }
    validateImportRecordFields(record);
    importedByLegacyKey.set(record.legacyUserKey, record);
    if (record.appleWithoutEmail) calculatedAppleWithoutEmail += 1;
    if (record.emailSignInUser) calculatedEmailSignInUsers += 1;
    if (record.bcryptAction === "IMPORT_BCRYPT") {
      calculatedBcryptMetadataUsers += 1;
    }
    if (record.bcryptAction === "PASSWORD_SETUP_REQUIRED") {
      calculatedSetupRequiredUsers += 1;
    }
  }
  if (
    [...dispositionByLegacyKey.values()].some(
      (record) =>
        (record.terminalDisposition === "IMPORTED_FIREBASE") !==
        importedByLegacyKey.has(record.legacyUserKey)
    ) ||
    calculatedDispositionCounts.linkedExistingFirebase !==
      plan.counts.linkedExistingFirebase ||
    calculatedDispositionCounts.importedFirebase !== plan.counts.importedFirebase ||
    calculatedDispositionCounts.calendarReconnectUsers !==
      plan.counts.calendarReconnectUsers ||
    calculatedAppleWithoutEmail !== plan.counts.appleWithoutEmail ||
    calculatedEmailSignInUsers !== plan.counts.emailSignInUsers ||
    calculatedBcryptMetadataUsers !== plan.counts.bcryptMetadataUsers ||
    calculatedSetupRequiredUsers !== plan.counts.setupRequiredUsers
  ) {
    fail(
      "FIREBASE_PLAN_COUNT_MISMATCH",
      "Firebase plan counts do not match their exact disposition records."
    );
  }
  const unclaimedLegacyKeys = new Set();
  for (const record of plan.unclaimedRecords) {
    exactKeys(
      record,
      [
        "legacyUserKey",
        "firebaseUidHash",
        "status",
        "accessAllowed",
        "firebaseImportAllowed",
        "recordHash",
      ],
      "INVALID_FIREBASE_PLAN_RECORD",
      "An unclaimed principal record has unexpected fields."
    );
    if (
      !SHA256_PATTERN.test(record.legacyUserKey ?? "") ||
      record.status !== "UNCLAIMED_LEGACY_PRINCIPAL" ||
      record.firebaseUidHash !== null ||
      record.accessAllowed !== false ||
      record.firebaseImportAllowed !== false ||
      dispositionByLegacyKey.has(record.legacyUserKey) ||
      unclaimedLegacyKeys.has(record.legacyUserKey)
    ) {
      fail(
        "INVALID_FIREBASE_PLAN_RECORD",
        "Unclaimed legacy principals must remain unique, unmapped, and denied."
      );
    }
    unclaimedLegacyKeys.add(record.legacyUserKey);
  }
  const importUidHashes = plan.firebaseImportRecords.map(
    ({ firebaseUidHash }) => firebaseUidHash
  );
  if (
    importUidHashes.some((hash) => !SHA256_PATTERN.test(hash ?? "")) ||
    new Set(importUidHashes).size !== importUidHashes.length
  ) {
    fail("DUPLICATE_FIREBASE_UID", "New Firebase import UIDs must remain globally unique.");
  }
  const expectedDispositionBatches = buildCheckpointBatches({
    records: plan.dispositionRecords,
    batchSize:
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.dispositionBatchSize,
    replayKey: plan.replayKey,
    stream: "firebase_identity_dispositions_dry_run",
  });
  const expectedImportBatches = buildCheckpointBatches({
    records: plan.firebaseImportRecords,
    batchSize:
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.firebaseImportBatchSize,
    replayKey: plan.replayKey,
    stream: "firebase_identity_imports_dry_run",
  });
  if (
    canonicalJson(plan.dispositionBatches) !== canonicalJson(expectedDispositionBatches) ||
    canonicalJson(plan.firebaseImportBatches) !== canonicalJson(expectedImportBatches)
  ) {
    fail("FIREBASE_CHECKPOINT_INTEGRITY_FAILURE", "Firebase batch checkpoints were modified.");
  }
  if (
    canonicalJson(plan.blockers) !==
      canonicalJson(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.blockers) ||
    plan.rollback.mode !== "DRY_RUN_NO_MUTATION" ||
    plan.rollback.createdUidCandidateCount !== lockedCounts.importedFirebase ||
    plan.rollback.existingLinkedUidDeletionAllowed !== false ||
    plan.rollback.createdUidDeletionAllowed !== false ||
    plan.rollback.evidenceSchemaHash !== plan.rollbackEvidenceSchemaHash ||
    plan.rollback.evidenceWriteMode !== "UNAVAILABLE_IN_DRY_RUN"
  ) {
    fail("EXECUTION_FORBIDDEN", "Firebase rollback or execution blockers were weakened.");
  }
  return Object.freeze({
    valid: true,
    replayKey: plan.replayKey,
    dispositionBatchCount: plan.dispositionBatches.length,
    firebaseImportBatchCount: plan.firebaseImportBatches.length,
  });
}

export function buildFirebaseIdentityImportDryRunPlan({
  mappingPlan,
  boundary,
  firebaseAuthority,
  calendarEvidence,
  reloginEpoch,
  authority = FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority,
  dryRun = true,
  execute,
  apply,
}) {
  assertDryRunOnly({ dryRun, execute, apply });
  assertAuthorityBinding(authority);
  const normalizedBoundary = lockedBoundary(boundary);
  const terminalCounts = validateTerminalDispositions(mappingPlan);
  if (
    mappingPlan.version !== 1 ||
    mappingPlan.mode !== "DRY_RUN" ||
    !SHA256_PATTERN.test(mappingPlan.sourceInventoryHash ?? "") ||
    !SHA256_PATTERN.test(mappingPlan.mappingInputHash ?? "") ||
    !SHA256_PATTERN.test(mappingPlan.mappingOutputHash ?? "")
  ) {
    fail("INVALID_MAPPING_PLAN", "A hash-bound dry-run identity mapping plan is required.");
  }
  const authorityIndex = validateFirebaseAuthorityIndex(firebaseAuthority);
  const calendar = validateCalendarEvidence(calendarEvidence, mappingPlan.authMappings);
  const reloginPolicy = buildReloginPolicy(reloginEpoch);
  const existingFirebaseUids = authorityIndex.firebaseUids;
  const existingProviderEvidenceOwners = authorityIndex.providerEvidenceOwners;
  const allActiveUids = new Set();
  for (const mapping of mappingPlan.authMappings) {
    if (typeof mapping.emailPresent !== "boolean") {
      fail("INVALID_MAPPING_PLAN", "Every Auth mapping must preserve email-presence metadata.");
    }
    if (mapping.status === "LINKED_EXISTING_FIREBASE") {
      if (!existingFirebaseUids.has(mapping.firebaseUid)) {
        fail(
          "EXISTING_FIREBASE_UID_NOT_FOUND",
          "A linked identity does not exist in the bound Firebase authority index."
        );
      }
      const resolvedProviderUids = mapping.providerEvidenceHashes.map((hash) =>
        existingProviderEvidenceOwners.get(hash)
      );
      const matchedProviderUids = new Set(resolvedProviderUids);
      if (
        resolvedProviderUids.some((uid) => uid === undefined) ||
        matchedProviderUids.size !== 1 ||
        !matchedProviderUids.has(mapping.firebaseUid)
      ) {
        fail(
          "FIREBASE_PROVIDER_LINK_MISMATCH",
          "An existing Firebase link lacks exact immutable provider-subject ownership."
        );
      }
    } else if (
      mapping.status === "IMPORTED_FIREBASE" &&
      existingFirebaseUids.has(mapping.firebaseUid)
    ) {
      fail(
        "GENERATED_FIREBASE_UID_COLLISION",
        "A deterministic import UID collides with an existing Firebase identity."
      );
    } else if (
      mapping.status === "IMPORTED_FIREBASE" &&
      mapping.providerEvidenceHashes.some((hash) =>
        existingProviderEvidenceOwners.has(hash)
      )
    ) {
      fail(
        "FIREBASE_PROVIDER_LINK_MISMATCH",
        "A new Firebase import already has immutable provider ownership in the authority."
      );
    }
    if (mapping.accessAllowed) {
      if (allActiveUids.has(mapping.firebaseUid)) {
        fail("DUPLICATE_FIREBASE_UID", "One Firebase UID cannot own two source identities.");
      }
      allActiveUids.add(mapping.firebaseUid);
    }
  }
  const orderedMappings = [...mappingPlan.authMappings].sort((left, right) =>
    left.legacyUserUuid < right.legacyUserUuid
      ? -1
      : left.legacyUserUuid > right.legacyUserUuid
        ? 1
        : 0
  );
  const dispositionRecords = orderedMappings.map((mapping) =>
    buildDispositionRecord(
      mapping,
      calendar.reconnectByLegacyUuid.get(mapping.legacyUserUuid.toLowerCase())
    )
  );
  const firebaseImportRecords = orderedMappings
    .filter(({ status }) => status === "IMPORTED_FIREBASE")
    .map((mapping) =>
      buildImportRecord(
        mapping,
        calendar.reconnectByLegacyUuid.get(mapping.legacyUserUuid.toLowerCase())
      )
    );
  const unclaimedRecords = [...mappingPlan.unclaimedMappings]
    .sort((left, right) =>
      left.legacyUserUuid < right.legacyUserUuid
        ? -1
        : left.legacyUserUuid > right.legacyUserUuid
          ? 1
          : 0
    )
    .map(buildUnclaimedRecord);
  const authorityBindingHash = canonicalHash(authority);
  const payloadSchemaHash = canonicalHash(
    FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.firebaseAdminImportSchema
  );
  const policyContractHash =
    SOURCE_CONTRACT.firebaseIdentityImportDryRunContractHash;
  const rollbackEvidenceSchemaHash = canonicalHash(
    FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.rollbackEvidenceSchema
  );
  const rollbackPolicy = buildRollbackPolicy(
    firebaseImportRecords.length,
    rollbackEvidenceSchemaHash
  );
  const futureExecutorGates = buildFutureExecutorGates();
  const reloginPolicyHash = validateReloginPolicy(reloginPolicy);
  const rollbackPolicyHash = validateRollbackPolicy(
    rollbackPolicy,
    firebaseImportRecords.length,
    rollbackEvidenceSchemaHash
  );
  const futureExecutorGatesHash = validateFutureExecutorGates(
    futureExecutorGates
  );
  const planInputHash = canonicalHash({
    version: 1,
    sourceInventoryHash: mappingPlan.sourceInventoryHash,
    mappingInputHash: mappingPlan.mappingInputHash,
    mappingOutputHash: mappingPlan.mappingOutputHash,
    authorityBindingHash,
    authorityIndexHash: authorityIndex.authorityIndexHash,
    calendarEvidenceHash: calendar.evidenceHash,
    reloginPolicyHash,
    rollbackPolicyHash,
    futureExecutorGatesHash,
    policyContractHash,
    payloadSchemaHash,
  });
  const run = createMigrationRunPlan({
    sourceInventoryHash: mappingPlan.sourceInventoryHash,
    mappingInputHash: planInputHash,
    target: normalizedBoundary.target,
    dryRun: true,
  });
  const dispositionBatches = buildCheckpointBatches({
    records: dispositionRecords,
    batchSize:
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.dispositionBatchSize,
    replayKey: run.replayKey,
    stream: "firebase_identity_dispositions_dry_run",
  });
  const firebaseImportBatches = buildCheckpointBatches({
    records: firebaseImportRecords,
    batchSize:
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.firebaseImportBatchSize,
    replayKey: run.replayKey,
    stream: "firebase_identity_imports_dry_run",
  });
  const bcryptMetadataUsers = firebaseImportRecords.filter(
    ({ bcryptAction }) => bcryptAction === "IMPORT_BCRYPT"
  ).length;
  const setupRequiredUsers = firebaseImportRecords.filter(
    ({ bcryptAction }) => bcryptAction === "PASSWORD_SETUP_REQUIRED"
  ).length;
  const plan = {
    version: 1,
    mode: "DRY_RUN",
    executionEnabled: false,
    applyReady: false,
    boundary: normalizedBoundary,
    authority: { ...authority },
    authorityBindingHash,
    authorityIndexHash: authorityIndex.authorityIndexHash,
    sourceInventoryHash: mappingPlan.sourceInventoryHash,
    mappingInputHash: mappingPlan.mappingInputHash,
    mappingOutputHash: mappingPlan.mappingOutputHash,
    calendarEvidenceHash: calendar.evidenceHash,
    policyContractHash,
    payloadSchemaHash,
    rollbackEvidenceSchemaHash,
    reloginPolicyHash,
    rollbackPolicyHash,
    futureExecutorGatesHash,
    planInputHash,
    replayKey: run.replayKey,
    relogin: reloginPolicy,
    counts: {
      authTerminalCount: terminalCounts.authTerminalCount,
      linkedExistingFirebase: terminalCounts.linkedExistingFirebase,
      importedFirebase: terminalCounts.importedFirebase,
      manualRecovery: terminalCounts.manualRecovery,
      legallyRetainedNoLogin: terminalCounts.legallyRetainedNoLogin,
      intentionallyDeleted: terminalCounts.intentionallyDeleted,
      appleWithoutEmail: terminalCounts.appleNoEmail,
      emailSignInUsers: terminalCounts.emailPasswordUsers,
      emailOnlyLinks: terminalCounts.emailOnlyLinks,
      unclaimedLegacyPrincipals: terminalCounts.unclaimedLegacyPrincipals,
      firebaseImportRecords: firebaseImportRecords.length,
      bcryptMetadataUsers,
      setupRequiredUsers,
      calendarReconnectUsers: calendar.reconnectRequiredCount,
    },
    dispositionRecords,
    firebaseImportRecords,
    unclaimedRecords,
    dispositionBatches,
    firebaseImportBatches,
    rollback: rollbackPolicy,
    futureExecutorGates,
    blockers: [...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.blockers],
  };
  validateFirebaseIdentityImportDryRunPlan(plan);
  return deepFreeze(plan);
}

export function firebaseIdentityImportDryRunSummary(plan) {
  validateFirebaseIdentityImportDryRunPlan(plan);
  return Object.freeze({
    version: plan.version,
    mode: plan.mode,
    executionEnabled: plan.executionEnabled,
    applyReady: plan.applyReady,
    boundary: plan.boundary,
    authority: plan.authority,
    authorityBindingHash: plan.authorityBindingHash,
    authorityIndexHash: plan.authorityIndexHash,
    sourceInventoryHash: plan.sourceInventoryHash,
    mappingInputHash: plan.mappingInputHash,
    mappingOutputHash: plan.mappingOutputHash,
    calendarEvidenceHash: plan.calendarEvidenceHash,
    policyContractHash: plan.policyContractHash,
    payloadSchemaHash: plan.payloadSchemaHash,
    rollbackEvidenceSchemaHash: plan.rollbackEvidenceSchemaHash,
    reloginPolicyHash: plan.reloginPolicyHash,
    rollbackPolicyHash: plan.rollbackPolicyHash,
    futureExecutorGatesHash: plan.futureExecutorGatesHash,
    planInputHash: plan.planInputHash,
    replayKey: plan.replayKey,
    relogin: {
      scope: plan.relogin.scope,
      productBinding: plan.relogin.productBinding,
      enforcement: plan.relogin.enforcement,
      epoch: plan.relogin.epoch,
      firebaseGlobalRevocationAllowed:
        plan.relogin.firebaseGlobalRevocationAllowed,
      researchSessionRevocationAllowed:
        plan.relogin.researchSessionRevocationAllowed,
    },
    counts: {
      authTerminalCount: plan.counts.authTerminalCount,
      linkedExistingFirebase: plan.counts.linkedExistingFirebase,
      importedFirebase: plan.counts.importedFirebase,
      manualRecovery: plan.counts.manualRecovery,
      legallyRetainedNoLogin: plan.counts.legallyRetainedNoLogin,
      intentionallyDeleted: plan.counts.intentionallyDeleted,
      appleWithoutEmail: plan.counts.appleWithoutEmail,
      emailSignInUsers: plan.counts.emailSignInUsers,
      emailOnlyLinks: plan.counts.emailOnlyLinks,
      unclaimedLegacyPrincipals: plan.counts.unclaimedLegacyPrincipals,
      firebaseImportRecords: plan.counts.firebaseImportRecords,
      bcryptMetadataUsers: plan.counts.bcryptMetadataUsers,
      setupRequiredUsers: plan.counts.setupRequiredUsers,
      calendarReconnectUsers: plan.counts.calendarReconnectUsers,
    },
    batches: {
      dispositions: {
        batchSize:
          FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.dispositionBatchSize,
        batchCount: plan.dispositionBatches.length,
        rowCounts: plan.dispositionBatches.map(({ rowCount }) => rowCount),
        checkpointHashes: plan.dispositionBatches.map(
          ({ checkpointHash }) => checkpointHash
        ),
      },
      firebaseImports: {
        batchSize:
          FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.batching.firebaseImportBatchSize,
        batchCount: plan.firebaseImportBatches.length,
        rowCounts: plan.firebaseImportBatches.map(({ rowCount }) => rowCount),
        checkpointHashes: plan.firebaseImportBatches.map(
          ({ checkpointHash }) => checkpointHash
        ),
      },
    },
    rollback: {
      mode: plan.rollback.mode,
      createdUidCandidateCount: plan.rollback.createdUidCandidateCount,
      existingLinkedUidDeletionAllowed:
        plan.rollback.existingLinkedUidDeletionAllowed,
      createdUidDeletionAllowed: plan.rollback.createdUidDeletionAllowed,
      evidenceSchemaHash: plan.rollback.evidenceSchemaHash,
      evidenceWriteMode: plan.rollback.evidenceWriteMode,
    },
    futureExecutorGates: {
      freshFirebaseAuthorityRead:
        plan.futureExecutorGates.freshFirebaseAuthorityRead,
      uidCollisionCheck: plan.futureExecutorGates.uidCollisionCheck,
      providerOwnershipCheck: plan.futureExecutorGates.providerOwnershipCheck,
      maximumEvidenceAgeSeconds:
        plan.futureExecutorGates.maximumEvidenceAgeSeconds,
      satisfiedByDryRun: plan.futureExecutorGates.satisfiedByDryRun,
    },
    blockers: [...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.blockers],
  });
}
