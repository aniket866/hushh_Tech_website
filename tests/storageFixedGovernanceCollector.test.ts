import { describe, expect, it, vi } from "vitest";

import {
  FixedStorageGovernanceReadClient,
  collectFixedStorageGovernanceSnapshot,
} from "../scripts/migration/storage-fixed-governance-collector.mjs";
import { ISOLATED_CUTOVER_CONTRACT } from
  "../scripts/migration/storage-isolated-cutover-contract.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  sha256,
} from "../scripts/migration/storage-live-common.mjs";

const project = "hushh-tech-uat";
const projectScope = `projects/${project}`;
const organizationScope = "organizations/369781862791";
const migrationWriter = ISOLATED_CUTOVER_CONTRACT.migrationWriterPrincipal;
const operator =
  "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com";

const response = (url: string, value: unknown, finalUrl = url) => {
  const result = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperties(result, {
    url: { value: finalUrl },
    redirected: { value: false },
  });
  return result;
};

const fixedFetch = ({
  inheritedWriter = false,
  operatorStorageAdmin = false,
  tokenCreator = false,
  hierarchyCycle = false,
  organizationDrift = false,
  redirectProject = false,
} = {}) => vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("http://metadata.google.internal/")) {
    expect(init?.method).toBe("GET");
    return response(url, { access_token: "fixed-governance-read-token" });
  }
  const parsed = new URL(url);
  if (parsed.pathname === `/v3/projects/${project}`) {
    expect(init?.method).toBe("GET");
    return response(url, {
      name: "projects/175298245599",
      projectId: project,
      state: "ACTIVE",
      parent: organizationDrift ? "organizations/999" : "folders/123",
    }, redirectProject ? `${url}?redirected=true` : url);
  }
  if (parsed.pathname === "/v3/folders/123") {
    expect(init?.method).toBe("GET");
    return response(url, {
      name: "folders/123",
      state: "ACTIVE",
      parent: hierarchyCycle ? "folders/123" : organizationScope,
    });
  }
  if (/^\/v3\/organizations\/[1-9]\d*$/.test(parsed.pathname)) {
    expect(init?.method).toBe("GET");
    return response(url, {
      name: parsed.pathname.slice("/v3/".length),
      state: "ACTIVE",
    });
  }
  if (parsed.pathname.endsWith(":getIamPolicy")) {
    expect(init?.method).toBe("POST");
    if (parsed.pathname.includes("serviceAccounts")) {
      expect(init?.body).toBeUndefined();
      expect(parsed.searchParams.get("options.requestedPolicyVersion")).toBe("3");
      return response(url, tokenCreator ? { bindings: [{
        role: "roles/iam.serviceAccountTokenCreator",
        members: [operator],
      }] } : {});
    }
    expect(init?.body).toBe(JSON.stringify({ options: { requestedPolicyVersion: 3 } }));
    if (parsed.pathname === `/v3/${projectScope}:getIamPolicy`) {
      const bindings: Array<Record<string, unknown>> = [{
        role: ISOLATED_CUTOVER_CONTRACT.inspectorRole,
        members: [ISOLATED_CUTOVER_CONTRACT.inspectorPrincipal],
      }];
      if (inheritedWriter || operatorStorageAdmin) {
        bindings.push({
          role: "roles/storage.admin",
          members: [inheritedWriter ? migrationWriter : operator],
        });
      }
      return response(url, { version: 3, bindings, etag: "project-etag" });
    }
    if (parsed.pathname === `/v3/${organizationScope}:getIamPolicy`) {
      return response(url, { version: 3, bindings: [], etag: "organization-etag" });
    }
    if (parsed.pathname === "/v3/folders/123:getIamPolicy") {
      return response(url, { version: 3, bindings: [], etag: "folder-etag" });
    }
  }
  if (parsed.pathname === `/v1/${ISOLATED_CUTOVER_CONTRACT.inspectorRole}`) {
    expect(init?.method).toBe("GET");
    return response(url, {
      name: ISOLATED_CUTOVER_CONTRACT.inspectorRole,
      includedPermissions: [...ISOLATED_CUTOVER_CONTRACT.inspectorPermissions],
      stage: "GA",
    });
  }
  if (parsed.pathname === "/v1/roles/storage.admin") {
    expect(init?.method).toBe("GET");
    return response(url, {
      name: "roles/storage.admin",
      includedPermissions: [
        "storage.buckets.get",
        "storage.objects.create",
        "storage.objects.delete",
        "storage.objects.get",
        "storage.objects.list",
      ],
      stage: "GA",
    });
  }
  throw new Error(`Unexpected fixed governance endpoint: ${url}`);
});

describe("fixed storage governance collector", () => {
  it("collects exact project and ancestor IAM plus service-account policy", async () => {
    const fetchImpl = fixedFetch();
    const times = [1_777_000_000_000, 1_777_000_000_125];
    const snapshot = await collectFixedStorageGovernanceSnapshot({
      client: new FixedStorageGovernanceReadClient({ fetchImpl }),
      now: () => times.shift()!,
    });

    expect(snapshot.hierarchyScopes).toEqual([
      projectScope,
      "folders/123",
      organizationScope,
    ]);
    expect(snapshot.inheritedBindings).toHaveLength(1);
    expect(snapshot.inheritedBindings[0]).toMatchObject({
      scope: projectScope,
      role: ISOLATED_CUTOVER_CONTRACT.inspectorRole,
      roleIncludedPermissions: [...ISOLATED_CUTOVER_CONTRACT.inspectorPermissions],
    });
    expect(snapshot.inheritedBindingsDigestSha256).toBe(
      sha256(canonicalJson(snapshot.inheritedBindings)),
    );
    expect(snapshot.snapshotDigestSha256).toBe(
      calculateSelfBoundDigest(snapshot, "snapshotDigestSha256"),
    );
    expect(snapshot.policyEvidence.operatorStorageAdminBindingCount).toBe(0);
    expect(snapshot.policyEvidence.migrationTokenCreatorBindingCount).toBe(0);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(4);
    expect(fetchImpl.mock.calls.every(([, init]) =>
      new Set(["GET", "POST"]).has(String(init?.method)))).toBe(true);
  });

  it("rejects a live inherited storage role for the deny-exempt writer", async () => {
    await expect(collectFixedStorageGovernanceSnapshot({
      client: new FixedStorageGovernanceReadClient({
        fetchImpl: fixedFetch({ inheritedWriter: true }),
      }),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({
      code: "FIXED_GOVERNANCE_EXCEPTION_INHERITED_ACCESS",
    });
  });

  it("rejects temporary operator storage-admin and token-creator grants", async () => {
    for (const options of [
      { operatorStorageAdmin: true },
      { tokenCreator: true },
    ]) {
      await expect(collectFixedStorageGovernanceSnapshot({
        client: new FixedStorageGovernanceReadClient({ fetchImpl: fixedFetch(options) }),
        now: 1_777_000_000_000,
      })).rejects.toMatchObject({ code: "TEMPORARY_GRANT_PRESENT" });
    }
  });

  it("fails closed on hierarchy cycles", async () => {
    await expect(collectFixedStorageGovernanceSnapshot({
      client: new FixedStorageGovernanceReadClient({
        fetchImpl: fixedFetch({ hierarchyCycle: true }),
      }),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "FIXED_GOVERNANCE_HIERARCHY_CYCLE" });
  });

  it("fails closed when the fixed project leaves its organization", async () => {
    await expect(collectFixedStorageGovernanceSnapshot({
      client: new FixedStorageGovernanceReadClient({
        fetchImpl: fixedFetch({ organizationDrift: true }),
      }),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "FIXED_ORGANIZATION_IDENTITY_DRIFT" });
  });

  it("fails closed when a fixed provider response changes endpoints", async () => {
    await expect(collectFixedStorageGovernanceSnapshot({
      client: new FixedStorageGovernanceReadClient({
        fetchImpl: fixedFetch({ redirectProject: true }),
      }),
      now: 1_777_000_000_000,
    })).rejects.toMatchObject({ code: "FIXED_PROJECT_READ_FAILED" });
  });
});
