import { describe, expect, it } from "vitest";

import {
  ISOLATED_CUTOVER_CONTRACT,
  expectedPreCopyBucketIamBindings,
  isolatedCutoverContractFileDigestSha256,
  isolationDenialConditionExpression,
  isolationExceptionPrincipals,
  isolationTagValueNamespacedName,
  validateIsolatedBucketAccessEvidence,
  validateIsolatedCutoverContract,
} from "../scripts/migration/storage-isolated-cutover-contract.mjs";
import { STORAGE_CUTOVER_CONTRACT } from "../scripts/migration/storage-cutover-contract.mjs";
import { canonicalJson, sha256 } from "../scripts/migration/storage-live-common.mjs";

const bucketMapping = (bucketName: string) => {
  const mapping = ISOLATED_CUTOVER_CONTRACT.buckets.find(
    (bucket: Record<string, string>) => bucket.targetBucket === bucketName,
  );
  if (!mapping) throw new Error("test bucket mapping missing");
  return mapping;
};

const tagsFor = (bucketName: string) => {
  const mapping = bucketMapping(bucketName);
  return [{
    parent: `//storage.googleapis.com/projects/_/buckets/${bucketName}`,
    tagValue: mapping.tagValueResource,
    tagValueNamespacedName: isolationTagValueNamespacedName(bucketName),
  }];
};

const exactDenyPolicy = () => ({
  kind: "DenyPolicy",
  displayName: ISOLATED_CUTOVER_CONTRACT.denyPolicyDisplayName,
  rules: ISOLATED_CUTOVER_CONTRACT.buckets.map(
    (mapping: Record<string, string>) => ({
      denyRule: {
        deniedPermissions: [...ISOLATED_CUTOVER_CONTRACT.deniedPermissions],
        deniedPrincipals: [...ISOLATED_CUTOVER_CONTRACT.deniedPrincipals],
        exceptionPrincipals: isolationExceptionPrincipals(mapping.targetBucket),
        denialCondition: {
          title: `Isolate ${mapping.targetBucket}`,
          expression: isolationDenialConditionExpression(mapping.targetBucket),
        },
      },
    }),
  ),
});

const evidenceFor = (
  bucketName: string,
  inheritedBindings: Array<Record<string, unknown>> = [],
) => validateIsolatedBucketAccessEvidence({
  bucketName,
  tagBindings: tagsFor(bucketName),
  denyPolicy: exactDenyPolicy(),
  inheritedBindings,
});

describe("isolated UAT storage cutover", () => {
  const bucketName = "hushh-tech-cutover-v1-assets-legal-uat";

  it("freezes six additive mappings and the exact checked-in contract", () => {
    expect(validateIsolatedCutoverContract()).toBe(ISOLATED_CUTOVER_CONTRACT);
    expect(ISOLATED_CUTOVER_CONTRACT.buckets).toHaveLength(6);
    expect(ISOLATED_CUTOVER_CONTRACT.deniedPermissions).toEqual(
      expect.arrayContaining([
        "storage.googleapis.com/buckets.deleteTagBinding",
        "storage.googleapis.com/buckets.setIamPolicy",
        "storage.googleapis.com/buckets.update",
        "storage.googleapis.com/objects.get",
        "storage.googleapis.com/objects.list",
        "storage.googleapis.com/objects.delete",
      ]),
    );
    expect(ISOLATED_CUTOVER_CONTRACT.deniedPermissions).toHaveLength(40);
    expect(ISOLATED_CUTOVER_CONTRACT.migrationWriterPermissions).toEqual([
      "storage.objects.create",
      "storage.objects.get",
      "storage.objects.list",
    ]);
    expect(ISOLATED_CUTOVER_CONTRACT.migrationWriterPermissions).not.toEqual(
      expect.arrayContaining(["storage.objects.delete", "storage.objects.update"]),
    );
    expect(STORAGE_CUTOVER_CONTRACT.buckets.every((bucket: Record<string, unknown>) =>
      canonicalJson(bucket.allowedIamBindings) ===
        canonicalJson(expectedPreCopyBucketIamBindings()) &&
      (bucket.signedUrlIssuers as unknown[]).length === 0)).toBe(true);
    expect(new Set(ISOLATED_CUTOVER_CONTRACT.buckets.map(
      (bucket: Record<string, string>) => bucket.targetBucket,
    )).size).toBe(6);
    expect(isolatedCutoverContractFileDigestSha256()).toMatch(/^[a-f0-9]{64}$/);
    expect(ISOLATED_CUTOVER_CONTRACT.executionPolicy).toMatchObject({
      bucketProvisioningAllowed: true,
      sourceMutationAllowed: false,
      existingTargetMutationAllowed: false,
      unrelatedObjectMutationAllowed: false,
      objectCopyAllowed: false,
      objectOverwriteAllowed: false,
      objectDeleteAllowed: false,
      productionMutationAllowed: false,
      runtimeRoutingAllowed: false,
    });
  });

  it("rejects a missing, wrong-resource, or cross-bucket isolation tag", () => {
    for (const tagBindings of [
      [],
      [{ ...tagsFor(bucketName)[0], tagValue: "tagValues/999999999999999" }],
      [{ ...tagsFor(bucketName)[0], parent: "//storage.googleapis.com/projects/_/buckets/other" }],
    ]) {
      expect(() => validateIsolatedBucketAccessEvidence({
        bucketName,
        tagBindings,
        denyPolicy: exactDenyPolicy(),
        inheritedBindings: [],
      })).toThrowError(expect.objectContaining({ code: "ISOLATED_CUTOVER_TAG_MISMATCH" }));
    }
  });

  it("rejects permission, principal, exception, and condition drift in the deny policy", () => {
    const mutations = [
      (policy: ReturnType<typeof exactDenyPolicy>) => {
        policy.rules[0].denyRule.deniedPermissions.pop();
      },
      (policy: ReturnType<typeof exactDenyPolicy>) => {
        policy.rules[0].denyRule.deniedPrincipals = ["principalSet://goog/cloudIdentityCustomerId/customers/unsafe"];
      },
      (policy: ReturnType<typeof exactDenyPolicy>) => {
        policy.rules[0].denyRule.exceptionPrincipals.push(
          "principal://iam.googleapis.com/projects/-/serviceAccounts/external@example.invalid",
        );
      },
      (policy: ReturnType<typeof exactDenyPolicy>) => {
        policy.rules[0].denyRule.denialCondition.expression = "resource.name.startsWith('unsafe')";
      },
    ];
    for (const mutate of mutations) {
      const denyPolicy = exactDenyPolicy();
      mutate(denyPolicy);
      expect(() => validateIsolatedBucketAccessEvidence({
        bucketName,
        tagBindings: tagsFor(bucketName),
        denyPolicy,
        inheritedBindings: [],
      })).toThrowError(expect.objectContaining({
        code: expect.stringMatching(/^ISOLATED_CUTOVER_DENY_/),
      }));
    }
  });

  it("keeps rollback and every runtime identity out of bucket IAM and deny exceptions", () => {
    const prohibited = new Set(
      ISOLATED_CUTOVER_CONTRACT.prohibitedPreCopyBucketPrincipals,
    );
    for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
      const bucketMembers = bucket.allowedIamBindings.flatMap(
        (binding: Record<string, unknown>) => binding.members as string[],
      );
      expect(bucketMembers.some((member: string) => prohibited.has(member))).toBe(false);
      const exceptions = isolationExceptionPrincipals(bucket.targetBucket);
      expect(exceptions).toHaveLength(2);
      expect(exceptions.some((principal: string) => [...prohibited].some(
        (member) => principal.endsWith(member.slice("serviceAccount:".length)),
      ))).toBe(false);
    }
    const denyPolicy = exactDenyPolicy();
    denyPolicy.rules[0].denyRule.exceptionPrincipals.push(
      "principal://iam.googleapis.com/projects/-/serviceAccounts/hushh-tech-rollback-uat@hushh-tech-uat.iam.gserviceaccount.com",
    );
    expect(() => validateIsolatedBucketAccessEvidence({
      bucketName,
      tagBindings: tagsFor(bucketName),
      denyPolicy,
      inheritedBindings: [],
    })).toThrowError(expect.objectContaining({
      code: "ISOLATED_CUTOVER_DENY_RULE_MISMATCH",
    }));
  });

  it("neutralizes custom organization roles, conditions, groups, and external principals", () => {
    const inheritedBindings = [
      {
        scope: "organizations/369781862791",
        role: "organizations/369781862791/roles/customStorageOperator",
        conditionDigestSha256: "a".repeat(64),
        members: [
          "group:legacy-storage@example.com",
          "principalSet://iam.googleapis.com/locations/global/workforcePools/external/attribute.department/vendor",
        ],
      },
      {
        scope: "projects/hushh-tech-uat",
        role: "roles/storage.admin",
        conditionDigestSha256: null,
        members: ["user:external@example.com"],
      },
    ];
    expect(evidenceFor(bucketName, inheritedBindings)).toMatchObject({
      isolationSafe: true,
      inheritedAccessNeutralized: true,
      inheritedStorageIamBindingCount: 2,
      inheritedStorageIamDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects any inherited storage grant on a deny exception identity", () => {
    const exceptionMember =
      "serviceAccount:hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com";
    expect(() => evidenceFor(bucketName, [{
      scope: "projects/hushh-tech-uat",
      role: "roles/storage.admin",
      conditionDigestSha256: null,
      members: [exceptionMember],
    }])).toThrowError(expect.objectContaining({
      code: "ISOLATED_CUTOVER_EXCEPTION_INHERITED_ACCESS",
    }));
  });

  it("allows only the exact metadata-only audit inspector role", () => {
    const exactInspector = {
      scope: "projects/hushh-tech-uat",
      role: ISOLATED_CUTOVER_CONTRACT.inspectorRole,
      conditionDigestSha256: null,
      members: [ISOLATED_CUTOVER_CONTRACT.inspectorPrincipal],
      roleIncludedPermissions: [...ISOLATED_CUTOVER_CONTRACT.inspectorPermissions],
      rolePermissionDigestSha256: sha256(
        canonicalJson(ISOLATED_CUTOVER_CONTRACT.inspectorPermissions),
      ),
    };
    expect(evidenceFor(bucketName, [exactInspector])).toMatchObject({
      isolationSafe: true,
      inheritedStorageIamBindingCount: 1,
    });
    expect(() => evidenceFor(bucketName, [{
      ...exactInspector,
      roleIncludedPermissions: [
        ...exactInspector.roleIncludedPermissions,
        "storage.objects.delete",
      ],
    }])).toThrowError(expect.objectContaining({
      code: "ISOLATED_CUTOVER_INSPECTOR_ROLE_DRIFT",
    }));
  });

  it("rejects malformed inherited custom-role and condition evidence", () => {
    expect(() => evidenceFor(bucketName, [{
      scope: "organizations/369781862791",
      role: "organizations/369781862791/roles/customStorageOperator",
      conditionDigestSha256: "not-a-digest",
      members: ["group:legacy-storage@example.com"],
    }])).toThrowError(expect.objectContaining({
      code: "ISOLATED_CUTOVER_INHERITED_IAM_INVALID",
    }));
  });
});
