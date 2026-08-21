import { createHash } from "node:crypto";

import { canonicalHash } from "./canonical-hash.mjs";
import { MigrationContractError, SOURCE_CONTRACT } from "./contract.mjs";
import { validateSourceInventory } from "./source-inventory.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_AUTH_STATUSES = new Set([
  "LINKED_EXISTING_FIREBASE",
  "IMPORTED_FIREBASE",
  "MANUAL_RECOVERY",
  "LEGALLY_RETAINED_NO_LOGIN",
  "INTENTIONALLY_DELETED",
]);
const EMAIL_PROVIDER_IDS = new Set(["email", "password", "email_link"]);

function providerKey(provider) {
  if (
    !provider ||
    typeof provider.providerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider.providerId) ||
    typeof provider.subject !== "string" ||
    provider.subject.length === 0 ||
    provider.subject.length > 512 ||
    provider.subject.includes("\u0000")
  ) {
    throw new MigrationContractError(
      "INVALID_PROVIDER_SUBJECT",
      "Provider evidence requires a bounded provider ID and immutable subject."
    );
  }
  const providerId = provider.providerId.toLowerCase().normalize("NFC");
  if (EMAIL_PROVIDER_IDS.has(providerId)) {
    throw new MigrationContractError(
      "EMAIL_EVIDENCE_FORBIDDEN",
      "Email/password provider evidence cannot participate in identity linking."
    );
  }
  return `${providerId}\u0000${provider.subject.normalize("NFC")}`;
}

function evidenceHash(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function deterministicFirebaseUid(user) {
  const providerKeys = user.providerSubjects.map(providerKey).sort();
  const seed =
    providerKeys.length > 0
      ? `provider-subjects:${providerKeys.join("\u0001")}`
      : `legacy-uuid:${SOURCE_CONTRACT.source.projectRef}:${user.legacyUserUuid.toLowerCase()}`;
  const digest = createHash("sha256").update(seed, "utf8").digest("base64url");
  return `ht_${digest.slice(0, 40)}`;
}

function passwordAction(user) {
  const isEmailPasswordUser = user.emailPresent && user.providerSubjects.length === 0;
  if (!isEmailPasswordUser) return "NOT_APPLICABLE";
  if (
    user.passwordCredential.present &&
    user.passwordCredential.algorithm === "BCRYPT"
  ) {
    return "IMPORT_BCRYPT";
  }
  return "PASSWORD_SETUP_REQUIRED";
}

function buildFirebaseProviderIndex(firebaseAuthority) {
  if (
    !firebaseAuthority ||
    typeof firebaseAuthority !== "object" ||
    Array.isArray(firebaseAuthority) ||
    Object.keys(firebaseAuthority).sort().join(",") !== "projectId,tenantId,users" ||
    firebaseAuthority.projectId !== SOURCE_CONTRACT.firebaseAuthority.projectId ||
    firebaseAuthority.tenantId !== SOURCE_CONTRACT.firebaseAuthority.tenantId ||
    !Array.isArray(firebaseAuthority.users)
  ) {
    throw new MigrationContractError(
      "FIREBASE_AUTHORITY_MISMATCH",
      "Firebase input must be the tenantless hushh-pda authority envelope."
    );
  }
  const firebaseUsers = firebaseAuthority.users;
  const firebaseUids = new Set();
  const index = new Map();
  for (const user of firebaseUsers) {
    if (
      !user ||
      typeof user.firebaseUid !== "string" ||
      user.firebaseUid.length === 0 ||
      user.firebaseUid.length > 128 ||
      !Array.isArray(user.providerSubjects)
    ) {
      throw new MigrationContractError(
        "INVALID_FIREBASE_USER",
        "Firebase users require a UID and providerSubjects array."
      );
    }
    if (firebaseUids.has(user.firebaseUid)) {
      throw new MigrationContractError("DUPLICATE_FIREBASE_UID", "Firebase UID is duplicated.");
    }
    firebaseUids.add(user.firebaseUid);
    for (const provider of user.providerSubjects) {
      const key = providerKey(provider);
      const matches = index.get(key) ?? new Set();
      matches.add(user.firebaseUid);
      index.set(key, matches);
    }
  }
  return Object.freeze({ index, firebaseUids, firebaseUsers });
}

function validateUnclaimedPrincipals(unclaimed, authLegacyUuids) {
  if (!Array.isArray(unclaimed)) {
    throw new MigrationContractError(
      "INVALID_UNCLAIMED_PRINCIPALS",
      "unclaimedLegacyPrincipals must be an array."
    );
  }
  const seen = new Set();
  return [...unclaimed]
    .sort((left, right) => {
      const leftUuid = left?.legacyUserUuid ?? "";
      const rightUuid = right?.legacyUserUuid ?? "";
      return leftUuid < rightUuid ? -1 : leftUuid > rightUuid ? 1 : 0;
    })
    .map((principal) => {
      const legacyUserUuid = principal?.legacyUserUuid?.toLowerCase();
      if (!UUID_PATTERN.test(legacyUserUuid ?? "")) {
        throw new MigrationContractError(
          "INVALID_LEGACY_UUID",
          "Unclaimed principals require a valid legacy UUID."
        );
      }
      if (seen.has(legacyUserUuid) || authLegacyUuids.has(legacyUserUuid)) {
        throw new MigrationContractError(
          "DUPLICATE_LEGACY_UUID",
          "An unclaimed principal must be unique and absent from Supabase Auth."
        );
      }
      seen.add(legacyUserUuid);
      return Object.freeze({
        legacyProject: SOURCE_CONTRACT.source.projectRef,
        legacyUserUuid,
        firebaseUid: null,
        status: "UNCLAIMED_LEGACY_PRINCIPAL",
        mappingBasis: "UNCLAIMED",
        emailWasUsed: false,
        accessAllowed: false,
        terminal: true,
      });
    });
}

export function buildIdentityMappingPlan({
  inventory,
  boundary,
  firebaseAuthority,
  unclaimedLegacyPrincipals,
}) {
  const inventorySummary = validateSourceInventory(inventory, boundary);
  const { index: firebaseIndex, firebaseUids, firebaseUsers } =
    buildFirebaseProviderIndex(firebaseAuthority);
  const authLegacyUuids = new Set(
    inventory.authUsers.map(({ legacyUserUuid }) => legacyUserUuid.toLowerCase())
  );

  const orderedAuthUsers = [...inventory.authUsers].sort((left, right) =>
    left.legacyUserUuid < right.legacyUserUuid ? -1 : left.legacyUserUuid > right.legacyUserUuid ? 1 : 0
  );
  const authMappings = orderedAuthUsers.map((user) => {
    const keys = user.providerSubjects.map(providerKey).sort();
    const matchedUids = new Set();
    for (const key of keys) {
      for (const uid of firebaseIndex.get(key) ?? []) matchedUids.add(uid);
    }
    const appleNoEmail =
      user.emailPresent === false &&
      user.providerSubjects.some(({ providerId }) => providerId.toLowerCase() === "apple.com");
    const isEmailPasswordUser = user.emailPresent && user.providerSubjects.length === 0;
    const common = {
      legacyProject: SOURCE_CONTRACT.source.projectRef,
      legacyUserUuid: user.legacyUserUuid.toLowerCase(),
      providerEvidenceHashes: keys.map(evidenceHash),
      emailWasUsed: false,
      appleNoEmail,
      isEmailPasswordUser,
      passwordAction: passwordAction(user),
      terminal: true,
    };

    if (matchedUids.size > 1) {
      return Object.freeze({
        ...common,
        firebaseUid: null,
        status: "MANUAL_RECOVERY",
        mappingBasis: "PROVIDER_SUBJECT_CONFLICT",
        accessAllowed: false,
      });
    }
    if (matchedUids.size === 1) {
      return Object.freeze({
        ...common,
        firebaseUid: [...matchedUids][0],
        status: "LINKED_EXISTING_FIREBASE",
        mappingBasis: "PROVIDER_SUBJECT",
        accessAllowed: true,
      });
    }
    const generatedFirebaseUid = deterministicFirebaseUid(user);
    if (firebaseUids.has(generatedFirebaseUid)) {
      throw new MigrationContractError(
        "GENERATED_FIREBASE_UID_COLLISION",
        "A deterministic import UID already belongs to an existing Firebase identity."
      );
    }
    return Object.freeze({
      ...common,
      firebaseUid: generatedFirebaseUid,
      status: "IMPORTED_FIREBASE",
      mappingBasis: keys.length > 0 ? "PROVIDER_SUBJECT" : "LEGACY_UUID",
      accessAllowed: true,
    });
  });

  const unclaimedMappings = validateUnclaimedPrincipals(
    unclaimedLegacyPrincipals,
    authLegacyUuids
  );
  const normalizedFirebaseUsers = [...firebaseUsers]
    .sort((left, right) =>
      left.firebaseUid < right.firebaseUid ? -1 : left.firebaseUid > right.firebaseUid ? 1 : 0
    )
    .map((user) => ({
      firebaseUid: user.firebaseUid,
      providerKeys: user.providerSubjects.map(providerKey).sort(),
    }));
  const normalizedUnclaimed = unclaimedMappings.map(({ legacyUserUuid }) => legacyUserUuid);
  const plan = {
    version: 1,
    mode: "DRY_RUN",
    sourceInventoryHash: inventorySummary.inventoryHash,
    mappingInputHash: canonicalHash({
      sourceInventoryHash: inventorySummary.inventoryHash,
      firebaseAuthority: {
        projectId: firebaseAuthority.projectId,
        tenantId: firebaseAuthority.tenantId,
        users: normalizedFirebaseUsers,
      },
      unclaimedLegacyPrincipals: normalizedUnclaimed,
    }),
    authMappings,
    unclaimedMappings,
  };
  return Object.freeze(plan);
}

export function validateTerminalDispositions(plan, { enforceLockedBaseline = true } = {}) {
  if (!plan || !Array.isArray(plan.authMappings) || !Array.isArray(plan.unclaimedMappings)) {
    throw new MigrationContractError("INVALID_MAPPING_PLAN", "Identity mapping plan is invalid.");
  }
  if (plan.authMappings.length !== SOURCE_CONTRACT.expected.authUsers) {
    throw new MigrationContractError(
      "AUTH_TERMINAL_COUNT_MISMATCH",
      "Exactly 369 Auth identities require terminal dispositions."
    );
  }

  const legacyUuids = new Set();
  const activeFirebaseUids = new Set();
  const counts = {
    linkedExistingFirebase: 0,
    importedFirebase: 0,
    manualRecovery: 0,
    legallyRetainedNoLogin: 0,
    intentionallyDeleted: 0,
    appleNoEmail: 0,
    emailPasswordUsers: 0,
    unclaimedLegacyPrincipals: plan.unclaimedMappings.length,
    emailOnlyLinks: 0,
  };

  for (const mapping of plan.authMappings) {
    if (!TERMINAL_AUTH_STATUSES.has(mapping.status) || mapping.terminal !== true) {
      throw new MigrationContractError(
        "NON_TERMINAL_IDENTITY",
        "Every Auth identity must have a supported terminal disposition."
      );
    }
    if (mapping.emailWasUsed !== false || mapping.mappingBasis === "EMAIL") {
      counts.emailOnlyLinks += 1;
    }
    if (
      mapping.legacyProject !== SOURCE_CONTRACT.source.projectRef ||
      !UUID_PATTERN.test(mapping.legacyUserUuid ?? "")
    ) {
      throw new MigrationContractError(
        "INVALID_MAPPING_PROVENANCE",
        "Every identity mapping must preserve the locked project and legacy UUID."
      );
    }
    if (
      !Array.isArray(mapping.providerEvidenceHashes) ||
      mapping.providerEvidenceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    ) {
      throw new MigrationContractError(
        "INVALID_PROVIDER_EVIDENCE",
        "Provider evidence must contain SHA-256 fingerprints only."
      );
    }
    if (
      mapping.status === "LINKED_EXISTING_FIREBASE" &&
      (mapping.mappingBasis !== "PROVIDER_SUBJECT" || mapping.providerEvidenceHashes.length === 0)
    ) {
      throw new MigrationContractError(
        "PROVIDER_PROOF_REQUIRED",
        "An existing Firebase link requires immutable provider-subject proof."
      );
    }
    if (
      mapping.status === "IMPORTED_FIREBASE" &&
      !["PROVIDER_SUBJECT", "LEGACY_UUID"].includes(mapping.mappingBasis)
    ) {
      throw new MigrationContractError(
        "INVALID_MAPPING_BASIS",
        "A new Firebase identity requires provider-subject or legacy-UUID provenance."
      );
    }
    if (
      mapping.isEmailPasswordUser &&
      !["IMPORT_BCRYPT", "PASSWORD_SETUP_REQUIRED"].includes(mapping.passwordAction)
    ) {
      throw new MigrationContractError(
        "INVALID_PASSWORD_ACTION",
        "Email/password identities require bcrypt import or password setup."
      );
    }
    if (legacyUuids.has(mapping.legacyUserUuid)) {
      throw new MigrationContractError("DUPLICATE_LEGACY_UUID", "Legacy UUID is duplicated.");
    }
    legacyUuids.add(mapping.legacyUserUuid);

    if (mapping.status === "LINKED_EXISTING_FIREBASE") counts.linkedExistingFirebase += 1;
    if (mapping.status === "IMPORTED_FIREBASE") counts.importedFirebase += 1;
    if (mapping.status === "MANUAL_RECOVERY") counts.manualRecovery += 1;
    if (mapping.status === "LEGALLY_RETAINED_NO_LOGIN") counts.legallyRetainedNoLogin += 1;
    if (mapping.status === "INTENTIONALLY_DELETED") counts.intentionallyDeleted += 1;
    if (mapping.appleNoEmail) counts.appleNoEmail += 1;
    if (mapping.isEmailPasswordUser) counts.emailPasswordUsers += 1;

    const shouldAllowAccess = ["LINKED_EXISTING_FIREBASE", "IMPORTED_FIREBASE"].includes(
      mapping.status
    );
    if (mapping.accessAllowed !== shouldAllowAccess) {
      throw new MigrationContractError(
        "INVALID_ACCESS_DISPOSITION",
        "Only linked or imported identities may be marked accessible."
      );
    }
    if (mapping.accessAllowed) {
      if (!mapping.firebaseUid) {
        throw new MigrationContractError(
          "ACTIVE_UID_REQUIRED",
          "An accessible identity must have a Firebase UID."
        );
      }
      if (activeFirebaseUids.has(mapping.firebaseUid)) {
        throw new MigrationContractError(
          "DUPLICATE_FIREBASE_UID",
          "A Firebase UID cannot own two active legacy identities."
        );
      }
      activeFirebaseUids.add(mapping.firebaseUid);
    }
  }

  for (const mapping of plan.unclaimedMappings) {
    if (
      mapping.status !== "UNCLAIMED_LEGACY_PRINCIPAL" ||
      mapping.firebaseUid !== null ||
      mapping.accessAllowed !== false ||
      mapping.emailWasUsed !== false ||
      mapping.terminal !== true
    ) {
      throw new MigrationContractError(
        "INVALID_UNCLAIMED_DISPOSITION",
        "Unclaimed legacy principals must remain unmapped and denied."
      );
    }
    if (legacyUuids.has(mapping.legacyUserUuid)) {
      throw new MigrationContractError(
        "DUPLICATE_LEGACY_UUID",
        "Unclaimed and Auth identities cannot share a legacy UUID."
      );
    }
    legacyUuids.add(mapping.legacyUserUuid);
  }

  if (counts.emailOnlyLinks !== 0) {
    throw new MigrationContractError(
      "EMAIL_ONLY_LINK_FORBIDDEN",
      "Email-only identity links are forbidden."
    );
  }
  if (enforceLockedBaseline) {
    const expected = SOURCE_CONTRACT.expected;
    if (
      counts.linkedExistingFirebase !== expected.existingFirebaseProviderLinks ||
      counts.importedFirebase !== expected.newFirebaseIdentities ||
      counts.appleNoEmail !== expected.appleUsersWithoutEmail ||
      counts.emailPasswordUsers !== expected.emailPasswordUsers ||
      counts.unclaimedLegacyPrincipals !== expected.unclaimedLegacyPrincipals ||
      counts.manualRecovery !== 0 ||
      counts.legallyRetainedNoLogin !== 0 ||
      counts.intentionallyDeleted !== 0
    ) {
      throw new MigrationContractError(
        "LOCKED_BASELINE_MISMATCH",
        "Identity dispositions do not match the frozen 165/204/3/4/65 baseline."
      );
    }
  }

  return Object.freeze({
    ...counts,
    authTerminalCount: plan.authMappings.length,
  });
}
