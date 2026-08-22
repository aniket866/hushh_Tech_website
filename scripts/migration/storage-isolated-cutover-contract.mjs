import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STORAGE_CUTOVER_CONTRACT } from "./storage-cutover-contract.mjs";
import {
  canonicalJson,
  fail,
  requireExactKeys,
  requireSafeText,
  sha256,
} from "./storage-live-common.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const ISOLATED_CUTOVER_CONTRACT_PATH = resolve(
  moduleDirectory,
  "..",
  "..",
  "migration",
  "storage",
  "supabase-storage-isolated-cutover-uat.v1.json",
);

export const ISOLATED_CUTOVER_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(ISOLATED_CUTOVER_CONTRACT_PATH, "utf8")),
);

const CONTRACT_KEYS = [
  "schemaVersion",
  "contractState",
  "environment",
  "project",
  "projectNumber",
  "organization",
  "location",
  "storageClass",
  "uniformBucketLevelAccess",
  "publicAccessPrevention",
  "versioningEnabled",
  "retentionPeriodSeconds",
  "retentionPolicyLocked",
  "softDeleteRetentionSeconds",
  "isolationTagKey",
  "isolationTagKeyResource",
  "denyPolicyId",
  "denyPolicyDisplayName",
  "inspectorRole",
  "inspectorPrincipal",
  "inspectorPermissions",
  "deniedPermissions",
  "deniedPrincipals",
  "buckets",
  "executionPolicy",
];

const BUCKET_KEYS = [
  "sourceBucket",
  "previousTargetBucket",
  "targetBucket",
  "tagValueShortName",
  "tagValueResource",
];

const EXECUTION_KEYS = [
  "bucketProvisioningAllowed",
  "sourceMutationAllowed",
  "existingTargetMutationAllowed",
  "unrelatedObjectMutationAllowed",
  "objectCopyAllowed",
  "objectOverwriteAllowed",
  "objectDeleteAllowed",
  "productionMutationAllowed",
  "runtimeRoutingAllowed",
];

const EXPECTED_MAPPINGS = [
  ["assets", "hushh-tech-assets-legal-uat", "hushh-tech-cutover-v1-assets-legal-uat", "cutover-assets-legal", "tagValues/281481430530521"],
  ["community-uploads", "hushh-tech-community-content-uat", "hushh-tech-cutover-v1-community-content-uat", "cutover-community", "tagValues/281479180988532"],
  ["hushh-agent-profile-images", "hushh-tech-profile-images-uat", "hushh-tech-cutover-v1-profile-images-uat", "cutover-profiles", "tagValues/281478947620546"],
  ["hushh-ai-media", "hushh-tech-ai-media-uat", "hushh-tech-cutover-v1-ai-media-uat", "cutover-ai-media", "tagValues/281476445421410"],
  ["hushh-gamma-pdf", "hushh-tech-reports-uat", "hushh-tech-cutover-v1-reports-uat", "cutover-reports", "tagValues/281483320182154"],
  ["wa-evidence", "hushh-tech-wa-evidence-uat", "hushh-tech-cutover-v1-wa-evidence-uat", "cutover-wa-evidence", "tagValues/281484883914223"],
].map(([sourceBucket, previousTargetBucket, targetBucket, tagValueShortName, tagValueResource]) => ({
  sourceBucket,
  previousTargetBucket,
  targetBucket,
  tagValueShortName,
  tagValueResource,
}));

const EXPECTED_DENIED_PERMISSIONS = [
  "storage.googleapis.com/bucketOperations.cancel",
  "storage.googleapis.com/buckets.createTagBinding",
  "storage.googleapis.com/buckets.delete",
  "storage.googleapis.com/buckets.deleteTagBinding",
  "storage.googleapis.com/buckets.enableObjectRetention",
  "storage.googleapis.com/buckets.relocate",
  "storage.googleapis.com/buckets.restore",
  "storage.googleapis.com/buckets.setIamPolicy",
  "storage.googleapis.com/buckets.setIpFilter",
  "storage.googleapis.com/buckets.update",
  "storage.googleapis.com/folders.create",
  "storage.googleapis.com/folders.delete",
  "storage.googleapis.com/folders.get",
  "storage.googleapis.com/folders.list",
  "storage.googleapis.com/folders.rename",
  "storage.googleapis.com/intelligenceConfigs.update",
  "storage.googleapis.com/managedFolders.create",
  "storage.googleapis.com/managedFolders.delete",
  "storage.googleapis.com/managedFolders.get",
  "storage.googleapis.com/managedFolders.getIamPolicy",
  "storage.googleapis.com/managedFolders.list",
  "storage.googleapis.com/managedFolders.setIamPolicy",
  "storage.googleapis.com/multipartUploads.abort",
  "storage.googleapis.com/multipartUploads.create",
  "storage.googleapis.com/multipartUploads.list",
  "storage.googleapis.com/multipartUploads.listParts",
  "storage.googleapis.com/objects.create",
  "storage.googleapis.com/objects.createContext",
  "storage.googleapis.com/objects.delete",
  "storage.googleapis.com/objects.deleteContext",
  "storage.googleapis.com/objects.get",
  "storage.googleapis.com/objects.getIamPolicy",
  "storage.googleapis.com/objects.list",
  "storage.googleapis.com/objects.move",
  "storage.googleapis.com/objects.overrideUnlockedRetention",
  "storage.googleapis.com/objects.restore",
  "storage.googleapis.com/objects.setIamPolicy",
  "storage.googleapis.com/objects.setRetention",
  "storage.googleapis.com/objects.update",
  "storage.googleapis.com/objects.updateContext",
];

export const isolatedCutoverContractFileDigestSha256 = () =>
  sha256(readFileSync(ISOLATED_CUTOVER_CONTRACT_PATH));

export const validateIsolatedCutoverContract = (
  contract = ISOLATED_CUTOVER_CONTRACT,
) => {
  requireExactKeys(contract, CONTRACT_KEYS, "ISOLATED_CUTOVER_CONTRACT_SCHEMA", "isolated cutover contract");
  if (!Array.isArray(contract.buckets) || contract.buckets.length !== 6) {
    fail("ISOLATED_CUTOVER_MAPPING_INVALID", "The isolated cutover requires exactly six bucket mappings.");
  }
  for (const bucket of contract.buckets) {
    requireExactKeys(bucket, BUCKET_KEYS, "ISOLATED_CUTOVER_CONTRACT_SCHEMA", "isolated bucket mapping");
  }
  requireExactKeys(
    contract.executionPolicy,
    EXECUTION_KEYS,
    "ISOLATED_CUTOVER_CONTRACT_SCHEMA",
    "isolated cutover execution policy",
  );
  const expectedTop = {
    schemaVersion: "hushh-tech-storage-isolated-cutover-uat-v1",
    contractState: "UAT_ISOLATION_PROVISIONING_ALLOWED_COPY_DISABLED",
    environment: "uat",
    project: "hushh-tech-uat",
    projectNumber: "175298245599",
    organization: "369781862791",
    location: "US-CENTRAL1",
    storageClass: "STANDARD",
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    versioningEnabled: true,
    retentionPeriodSeconds: 604_800,
    retentionPolicyLocked: false,
    softDeleteRetentionSeconds: 604_800,
    isolationTagKey: "369781862791/storage-isolation",
    isolationTagKeyResource: "tagKeys/281475718825896",
    denyPolicyId: "hushh-tech-storage-cutover-v1",
    denyPolicyDisplayName: "Hushh Tech UAT isolated storage cutover v1",
    inspectorRole: "projects/hushh-tech-uat/roles/hushhTechStorageCutoverInspector",
    inspectorPrincipal:
      "serviceAccount:hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com",
  };
  if (Object.entries(expectedTop).some(([key, value]) => contract[key] !== value)) {
    fail("ISOLATED_CUTOVER_CONTRACT_DRIFT", "The isolated UAT cutover scope changed.");
  }
  if (
    canonicalJson(contract.buckets) !== canonicalJson(EXPECTED_MAPPINGS) ||
    canonicalJson(contract.deniedPermissions) !== canonicalJson(EXPECTED_DENIED_PERMISSIONS) ||
    canonicalJson(contract.inspectorPermissions) !== canonicalJson([
      "iam.denypolicies.get",
      "storage.buckets.get",
      "storage.buckets.getIamPolicy",
      "storage.buckets.listTagBindings",
    ]) ||
    canonicalJson(contract.deniedPrincipals) !== canonicalJson(["principalSet://goog/public:all"]) ||
    contract.executionPolicy.bucketProvisioningAllowed !== true ||
    Object.entries(contract.executionPolicy).some(([key, value]) =>
      key !== "bucketProvisioningAllowed" && value !== false)
  ) {
    fail("ISOLATED_CUTOVER_CONTRACT_DRIFT", "The isolated bucket or execution policy changed.");
  }
  const baseMappings = STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => ({
    sourceBucket: bucket.sourceBucket,
    targetBucket: bucket.targetBucket,
  }));
  const isolatedMappings = contract.buckets.map((bucket) => ({
    sourceBucket: bucket.sourceBucket,
    targetBucket: bucket.targetBucket,
  }));
  if (canonicalJson(baseMappings) !== canonicalJson(isolatedMappings)) {
    fail("ISOLATED_CUTOVER_BASE_MAPPING_MISMATCH", "The base storage contract is not bound to isolated targets.");
  }
  return contract;
};

const bucketContract = (bucketName) => {
  validateIsolatedCutoverContract();
  const mapping = ISOLATED_CUTOVER_CONTRACT.buckets.find((bucket) =>
    bucket.targetBucket === bucketName);
  if (!mapping) fail("ISOLATED_CUTOVER_BUCKET_UNKNOWN", "An unknown isolated bucket was supplied.");
  return {
    ...mapping,
    base: STORAGE_CUTOVER_CONTRACT.buckets.find((bucket) =>
      bucket.sourceBucket === mapping.sourceBucket),
  };
};

const principalForMember = (member) => {
  if (
    typeof member !== "string" ||
    !member.startsWith("serviceAccount:") ||
    !member.endsWith("@hushh-tech-uat.iam.gserviceaccount.com")
  ) {
    fail("ISOLATED_CUTOVER_EXCEPTION_INVALID", "Isolation exceptions must be exact UAT service accounts.");
  }
  return `principal://iam.googleapis.com/projects/-/serviceAccounts/${member.slice("serviceAccount:".length)}`;
};

export const isolationExceptionPrincipals = (bucketName) => {
  const { base } = bucketContract(bucketName);
  return [...new Set(base.allowedIamBindings.flatMap((binding) =>
    binding.members.map(principalForMember)))].sort();
};

export const isolationTagValueNamespacedName = (bucketName) => {
  const mapping = bucketContract(bucketName);
  return `${ISOLATED_CUTOVER_CONTRACT.isolationTagKey}/${mapping.tagValueShortName}`;
};

export const isolationDenialConditionExpression = (bucketName) => {
  const mapping = bucketContract(bucketName);
  return `resource.matchTag('${ISOLATED_CUTOVER_CONTRACT.isolationTagKey}', '${mapping.tagValueShortName}')`;
};

const normalizedDenyRules = (denyPolicy) => {
  if (
    denyPolicy?.kind !== "DenyPolicy" ||
    denyPolicy.displayName !== ISOLATED_CUTOVER_CONTRACT.denyPolicyDisplayName ||
    !Array.isArray(denyPolicy.rules) ||
    denyPolicy.rules.length !== 6
  ) {
    fail("ISOLATED_CUTOVER_DENY_POLICY_INVALID", "The isolated cutover deny policy shape changed.");
  }
  return denyPolicy.rules.map((rule) => {
    const denyRule = rule?.denyRule;
    const condition = denyRule?.denialCondition;
    if (
      !denyRule ||
      !condition ||
      typeof condition.expression !== "string" ||
      typeof condition.title !== "string" ||
      !Array.isArray(denyRule.deniedPermissions) ||
      !Array.isArray(denyRule.deniedPrincipals) ||
      !Array.isArray(denyRule.exceptionPrincipals)
    ) {
      fail("ISOLATED_CUTOVER_DENY_POLICY_INVALID", "An isolated deny rule is malformed.");
    }
    return {
      expression: condition.expression,
      title: condition.title,
      deniedPermissions: [...denyRule.deniedPermissions].sort(),
      deniedPrincipals: [...denyRule.deniedPrincipals].sort(),
      exceptionPrincipals: [...denyRule.exceptionPrincipals].sort(),
    };
  }).sort((left, right) => left.expression.localeCompare(right.expression));
};

export const validateIsolatedBucketAccessEvidence = ({
  bucketName,
  tagBindings,
  denyPolicy,
  inheritedBindings,
}) => {
  const mapping = bucketContract(bucketName);
  if (!Array.isArray(tagBindings) || !Array.isArray(inheritedBindings)) {
    fail("ISOLATED_CUTOVER_EVIDENCE_INVALID", "Isolation evidence arrays are missing.");
  }
  const expectedTag = isolationTagValueNamespacedName(bucketName);
  const expectedParent =
    `//storage.googleapis.com/projects/_/buckets/${mapping.targetBucket}`;
  const isolationBindings = tagBindings.filter((binding) =>
    typeof binding?.tagValueNamespacedName === "string" &&
    binding.tagValueNamespacedName.startsWith(`${ISOLATED_CUTOVER_CONTRACT.isolationTagKey}/`));
  if (
    isolationBindings.length !== 1 ||
    isolationBindings[0].parent !== expectedParent ||
    isolationBindings[0].tagValueNamespacedName !== expectedTag ||
    isolationBindings[0].tagValue !== mapping.tagValueResource
  ) {
    fail("ISOLATED_CUTOVER_TAG_MISMATCH", "The isolated bucket tag binding changed.");
  }
  const rules = normalizedDenyRules(denyPolicy);
  const expectedExpressions = ISOLATED_CUTOVER_CONTRACT.buckets
    .map((bucket) => isolationDenialConditionExpression(bucket.targetBucket))
    .sort();
  if (canonicalJson(rules.map((rule) => rule.expression)) !== canonicalJson(expectedExpressions)) {
    fail("ISOLATED_CUTOVER_DENY_POLICY_INVALID", "The deny policy is missing an exact isolated bucket rule.");
  }
  const expression = isolationDenialConditionExpression(bucketName);
  const rule = rules.find((candidate) => candidate.expression === expression);
  const expectedExceptions = isolationExceptionPrincipals(bucketName);
  if (
    !rule ||
    rule.title !== `Isolate ${mapping.targetBucket}` ||
    canonicalJson(rule.deniedPermissions) !== canonicalJson(EXPECTED_DENIED_PERMISSIONS) ||
    canonicalJson(rule.deniedPrincipals) !== canonicalJson(["principalSet://goog/public:all"]) ||
    canonicalJson(rule.exceptionPrincipals) !== canonicalJson(expectedExceptions)
  ) {
    fail("ISOLATED_CUTOVER_DENY_RULE_MISMATCH", "The isolated bucket deny rule changed.");
  }
  const exceptionMembers = new Set(mapping.base.allowedIamBindings.flatMap((binding) => binding.members));
  for (const binding of inheritedBindings) {
    requireSafeText(binding?.role, "ISOLATED_CUTOVER_INHERITED_IAM_INVALID", "inherited role", 512);
    if (
      typeof binding.scope !== "string" ||
      !/^(?:projects|folders|organizations)\/[A-Za-z0-9._-]+$/.test(binding.scope) ||
      (binding.conditionDigestSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(binding.conditionDigestSha256 || "")) ||
      !Array.isArray(binding.members) ||
      binding.members.length === 0
    ) {
      fail("ISOLATED_CUTOVER_INHERITED_IAM_INVALID", "An inherited storage binding is malformed.");
    }
    for (const member of binding.members) {
      requireSafeText(
        member,
        "ISOLATED_CUTOVER_INHERITED_IAM_INVALID",
        "inherited IAM member",
        1_024,
      );
    }
    const inspectorBinding =
      binding.scope === `projects/${ISOLATED_CUTOVER_CONTRACT.project}` &&
      binding.role === ISOLATED_CUTOVER_CONTRACT.inspectorRole &&
      binding.conditionDigestSha256 === null &&
      canonicalJson(binding.members) ===
        canonicalJson([ISOLATED_CUTOVER_CONTRACT.inspectorPrincipal]) &&
      canonicalJson(binding.roleIncludedPermissions) ===
        canonicalJson(ISOLATED_CUTOVER_CONTRACT.inspectorPermissions) &&
      binding.rolePermissionDigestSha256 === sha256(
        canonicalJson(ISOLATED_CUTOVER_CONTRACT.inspectorPermissions),
      );
    if (binding.role === ISOLATED_CUTOVER_CONTRACT.inspectorRole && !inspectorBinding) {
      fail(
        "ISOLATED_CUTOVER_INSPECTOR_ROLE_DRIFT",
        "The cutover inspector role or binding changed.",
      );
    }
    if (
      !inspectorBinding &&
      binding.members.some((member) => exceptionMembers.has(member))
    ) {
      fail(
        "ISOLATED_CUTOVER_EXCEPTION_INHERITED_ACCESS",
        "An isolation exception also has inherited storage access.",
      );
    }
  }
  const normalizedInherited = inheritedBindings.map((binding) => ({
    scope: binding.scope ?? null,
    role: binding.role,
    conditionDigestSha256: binding.conditionDigestSha256 ?? null,
    members: [...binding.members].sort(),
    ...(binding.roleIncludedPermissions ? {
      roleIncludedPermissions: [...binding.roleIncludedPermissions].sort(),
      rolePermissionDigestSha256: binding.rolePermissionDigestSha256,
    } : {}),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    isolationSafe: true,
    tagValueNamespacedName: expectedTag,
    tagBindingDigestSha256: sha256(canonicalJson(isolationBindings)),
    denyPolicyDigestSha256: sha256(canonicalJson(rules)),
    denyRuleDigestSha256: sha256(canonicalJson(rule)),
    exceptionPrincipalDigestSha256: sha256(canonicalJson(expectedExceptions)),
    inheritedStorageIamBindingCount: inheritedBindings.length,
    inheritedStorageIamDigestSha256: sha256(canonicalJson(normalizedInherited)),
    inheritedAccessNeutralized: true,
  };
};
