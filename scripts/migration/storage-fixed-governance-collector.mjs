import {
  ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
  validateZeroGrantPolicyEvidence,
} from "./storage-seven-bucket-contract.mjs";
import { ISOLATED_CUTOVER_CONTRACT } from "./storage-isolated-cutover-contract.mjs";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  isPlainObject,
  requireExactKeys,
  requireIsoTimestamp,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const PROJECT = "hushh-tech-uat";
const PROJECT_NUMBER = "175298245599";
const PROJECT_SCOPE = `projects/${PROJECT}`;
const ORGANIZATION_SCOPE = "organizations/369781862791";
const MIGRATION_SERVICE_ACCOUNT =
  "hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com";
const OPERATOR_PRINCIPAL =
  "serviceAccount:claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const RESOURCE_MANAGER_HOST = "cloudresourcemanager.googleapis.com";
const IAM_HOST = "iam.googleapis.com";
const MAXIMUM_RESPONSE_BYTES = 8_388_608;
const MAXIMUM_COLLECTION_MS = 300_000;
const MAXIMUM_HIERARCHY_DEPTH = 16;
const MAXIMUM_BINDINGS = 10_000;
const MAXIMUM_ROLES = 512;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUESTED_POLICY_VERSION_BODY = JSON.stringify({
  options: { requestedPolicyVersion: 3 },
});

export const FIXED_GOVERNANCE_REQUIRED_PERMISSIONS = Object.freeze([
  "iam.roles.get",
  "iam.serviceAccounts.getIamPolicy",
  "resourcemanager.folders.get",
  "resourcemanager.folders.getIamPolicy",
  "resourcemanager.organizations.get",
  "resourcemanager.organizations.getIamPolicy",
  "resourcemanager.projects.get",
  "resourcemanager.projects.getIamPolicy",
]);

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "capturedAt",
  "collectionStartedAt",
  "collectionCompletedAt",
  "collectionDurationMs",
  "project",
  "projectNumber",
  "hierarchyScopes",
  "inheritedBindings",
  "inheritedBindingsDigestSha256",
  "policyEvidence",
  "snapshotDigestSha256",
];

const boundedJson = async (response, code) => {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    fail(code, "A fixed governance response exceeded its byte bound.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
    fail(code, "A fixed governance response exceeded its byte bound.");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "A fixed governance response was not valid JSON.");
  }
  if (!isPlainObject(value)) {
    fail(code, "A fixed governance response was not a JSON object.");
  }
  return { bytes, value };
};

const validResourceName = (value, kind) =>
  typeof value === "string" &&
  new RegExp(`^${kind}/[1-9]\\d*$`).test(value);

const normalizePolicyBindings = (policy, scope, code) => {
  if (
    !isPlainObject(policy) ||
    (policy.bindings !== undefined && !Array.isArray(policy.bindings))
  ) {
    fail(code, "A fixed IAM policy was malformed.");
  }
  const bindings = policy.bindings || [];
  if (bindings.length > MAXIMUM_BINDINGS) {
    fail(code, "A fixed IAM policy exceeded its binding bound.");
  }
  return bindings.map((binding) => {
    if (
      !isPlainObject(binding) ||
      typeof binding.role !== "string" ||
      binding.role.length === 0 ||
      binding.role.length > 512 ||
      !Array.isArray(binding.members) ||
      binding.members.length === 0 ||
      binding.members.length > 10_000 ||
      binding.members.some((member) =>
        typeof member !== "string" || member.length === 0 || member.length > 1_024)
    ) {
      fail(code, "A fixed IAM binding was malformed.");
    }
    const members = [...binding.members].sort();
    if (new Set(members).size !== members.length) {
      fail(code, "A fixed IAM binding contained a duplicate principal.");
    }
    if (binding.condition !== undefined && !isPlainObject(binding.condition)) {
      fail(code, "A fixed IAM condition was malformed.");
    }
    return {
      scope,
      role: binding.role,
      members,
      conditionDigestSha256: binding.condition
        ? sha256(canonicalJson(binding.condition))
        : null,
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
};

const normalizeRole = (role, response) => {
  if (
    !isPlainObject(response) ||
    response.name !== role ||
    response.deleted === true ||
    !Array.isArray(response.includedPermissions) ||
    response.includedPermissions.length === 0 ||
    response.includedPermissions.length > 10_000 ||
    response.includedPermissions.some((permission) =>
      typeof permission !== "string" ||
      permission.length === 0 ||
      permission.length > 512)
  ) {
    fail("FIXED_GOVERNANCE_ROLE_INVALID", "An inherited IAM role could not be resolved exactly.");
  }
  const includedPermissions = [...response.includedPermissions].sort();
  if (new Set(includedPermissions).size !== includedPermissions.length) {
    fail("FIXED_GOVERNANCE_ROLE_INVALID", "An inherited IAM role repeated a permission.");
  }
  return includedPermissions;
};

const resolveClock = (now) => {
  if (now === undefined) return Date.now;
  if (typeof now === "function") return now;
  if (Number.isSafeInteger(now) && now >= 0) return () => now;
  fail("FIXED_GOVERNANCE_CLOCK_INVALID", "The governance collection clock is invalid.");
};

export class FixedStorageGovernanceReadClient {
  #fetchImpl;
  #accessToken = null;
  #accessTokenPromise = null;

  constructor({ fetchImpl = fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      fail("FIXED_GOVERNANCE_FETCH_INVALID", "The fixed governance client requires fetch.");
    }
    this.#fetchImpl = fetchImpl;
  }

  async #token() {
    if (this.#accessToken) return this.#accessToken;
    if (this.#accessTokenPromise) return this.#accessTokenPromise;
    this.#accessTokenPromise = this.#loadToken();
    try {
      return await this.#accessTokenPromise;
    } finally {
      this.#accessTokenPromise = null;
    }
  }

  async #loadToken() {
    let response;
    try {
      response = await this.#fetchImpl(METADATA_TOKEN_URL, {
        method: "GET",
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("FIXED_GOVERNANCE_CREDENTIAL_UNAVAILABLE", "The metadata credential is unavailable.");
    }
    if (!response?.ok || response.redirected !== false || response.url !== METADATA_TOKEN_URL) {
      fail("FIXED_GOVERNANCE_CREDENTIAL_UNAVAILABLE", "The metadata credential changed endpoints or failed.");
    }
    const { value } = await boundedJson(response, "FIXED_GOVERNANCE_CREDENTIAL_UNAVAILABLE");
    if (typeof value.access_token !== "string" || value.access_token.length < 20) {
      fail("FIXED_GOVERNANCE_CREDENTIAL_UNAVAILABLE", "The metadata credential was invalid.");
    }
    this.#accessToken = value.access_token;
    return this.#accessToken;
  }

  async #request(url, { method, body = undefined, code }) {
    const resourceManagerPolicyRead =
      method === "POST" &&
      url.hostname === RESOURCE_MANAGER_HOST &&
      /^\/v3\/(?:projects\/[A-Za-z0-9._-]+|folders\/[1-9]\d*|organizations\/[1-9]\d*):getIamPolicy$/.test(
        url.pathname,
      ) &&
      url.search === "" &&
      body === REQUESTED_POLICY_VERSION_BODY;
    const serviceAccountPolicyRead =
      method === "POST" &&
      url.hostname === IAM_HOST &&
      url.pathname ===
        `/v1/projects/${PROJECT}/serviceAccounts/${encodeURIComponent(MIGRATION_SERVICE_ACCOUNT)}:getIamPolicy` &&
      url.searchParams.size === 1 &&
      url.searchParams.get("options.requestedPolicyVersion") === "3" &&
      body === undefined;
    if (
      !(url instanceof URL) ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== "" ||
      !new Set([RESOURCE_MANAGER_HOST, IAM_HOST]).has(url.hostname) ||
      !new Set(["GET", "POST"]).has(method) ||
      (method === "GET" && body !== undefined) ||
      (method === "POST" && !resourceManagerPolicyRead && !serviceAccountPolicyRead)
    ) {
      fail("FIXED_GOVERNANCE_ENDPOINT_BLOCKED", "A non-frozen governance request was blocked.");
    }
    const token = await this.#token();
    let response;
    try {
      response = await this.#fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail(code, "A fixed governance request failed.");
    }
    if (!response?.ok || response.redirected !== false || response.url !== url.href) {
      fail(code, "A fixed governance request failed or changed endpoints.");
    }
    return boundedJson(response, code);
  }

  #get(path, code) {
    return this.#request(new URL(`https://${RESOURCE_MANAGER_HOST}${path}`), {
      method: "GET",
      code,
    });
  }

  #getIamPolicy(scope, host = RESOURCE_MANAGER_HOST) {
    return this.#request(new URL(`https://${host}/v3/${scope}:getIamPolicy`), {
      method: "POST",
      body: REQUESTED_POLICY_VERSION_BODY,
      code: "FIXED_GOVERNANCE_POLICY_READ_FAILED",
    });
  }

  async readHierarchy() {
    const project = await this.#get(`/v3/projects/${PROJECT}`, "FIXED_PROJECT_READ_FAILED");
    if (
      project.value.name !== `projects/${PROJECT_NUMBER}` ||
      project.value.projectId !== PROJECT ||
      project.value.state !== "ACTIVE" ||
      (!validResourceName(project.value.parent, "folders") &&
        !validResourceName(project.value.parent, "organizations"))
    ) {
      fail("FIXED_PROJECT_IDENTITY_DRIFT", "The fixed UAT project identity or parent changed.");
    }
    const scopes = [PROJECT_SCOPE];
    const seen = new Set(scopes);
    let parent = project.value.parent;
    for (let depth = 0; depth < MAXIMUM_HIERARCHY_DEPTH; depth += 1) {
      if (seen.has(parent)) {
        fail("FIXED_GOVERNANCE_HIERARCHY_CYCLE", "The resource hierarchy contained a cycle.");
      }
      seen.add(parent);
      scopes.push(parent);
      if (parent.startsWith("organizations/")) {
        const organization = await this.#get(
          `/v3/${parent}`,
          "FIXED_ORGANIZATION_READ_FAILED",
        );
        if (
          parent !== ORGANIZATION_SCOPE ||
          organization.value.name !== ORGANIZATION_SCOPE ||
          organization.value.state !== "ACTIVE"
        ) {
          fail("FIXED_ORGANIZATION_IDENTITY_DRIFT", "The project organization changed.");
        }
        return scopes;
      }
      const folder = await this.#get(`/v3/${parent}`, "FIXED_FOLDER_READ_FAILED");
      if (
        folder.value.name !== parent ||
        folder.value.state !== "ACTIVE" ||
        (!validResourceName(folder.value.parent, "folders") &&
          !validResourceName(folder.value.parent, "organizations"))
      ) {
        fail("FIXED_FOLDER_IDENTITY_DRIFT", "A project folder identity or parent changed.");
      }
      parent = folder.value.parent;
    }
    fail("FIXED_GOVERNANCE_HIERARCHY_DEPTH", "The resource hierarchy exceeded its depth bound.");
  }

  readScopePolicy(scope) {
    if (
      scope !== PROJECT_SCOPE &&
      !validResourceName(scope, "folders") &&
      !validResourceName(scope, "organizations")
    ) {
      fail("FIXED_GOVERNANCE_SCOPE_BLOCKED", "An unknown governance scope was blocked.");
    }
    return this.#getIamPolicy(scope);
  }

  readMigrationServiceAccountPolicy() {
    const resource = `projects/${PROJECT}/serviceAccounts/${encodeURIComponent(MIGRATION_SERVICE_ACCOUNT)}`;
    const url = new URL(`https://${IAM_HOST}/v1/${resource}:getIamPolicy`);
    url.searchParams.set("options.requestedPolicyVersion", "3");
    return this.#request(
      url,
      {
        method: "POST",
        code: "FIXED_MIGRATION_SERVICE_ACCOUNT_POLICY_READ_FAILED",
      },
    );
  }

  readRole(role, hierarchyScopes) {
    const organizations = new Set(
      hierarchyScopes.filter((scope) => scope.startsWith("organizations/")),
    );
    const allowed =
      /^roles\/[A-Za-z0-9_.-]+$/.test(role) ||
      new RegExp(`^projects/(?:${PROJECT}|${PROJECT_NUMBER})/roles/[A-Za-z0-9_.-]+$`).test(role) ||
      (/^organizations\/[1-9]\d*\/roles\/[A-Za-z0-9_.-]+$/.test(role) &&
        organizations.has(role.split("/roles/")[0]));
    if (!allowed) {
      fail("FIXED_GOVERNANCE_ROLE_BLOCKED", "An IAM role outside the fixed hierarchy was blocked.");
    }
    return this.#request(new URL(`https://${IAM_HOST}/v1/${role}`), {
      method: "GET",
      code: "FIXED_GOVERNANCE_ROLE_READ_FAILED",
    });
  }
}

const normalizeSnapshotInheritedBindings = (bindings, hierarchyScopes) => {
  if (!Array.isArray(bindings) || bindings.length > MAXIMUM_BINDINGS) {
    fail("FIXED_GOVERNANCE_INHERITED_IAM_INVALID", "Inherited storage IAM was malformed.");
  }
  const normalized = bindings.map((binding) => {
    const inspector = binding?.role === ISOLATED_CUTOVER_CONTRACT.inspectorRole;
    requireExactKeys(
      binding,
      inspector
        ? [
            "scope", "role", "members", "conditionDigestSha256",
            "roleIncludedPermissions", "rolePermissionDigestSha256",
          ]
        : ["scope", "role", "members", "conditionDigestSha256"],
      "FIXED_GOVERNANCE_INHERITED_IAM_INVALID",
      "inherited storage IAM binding",
    );
    if (
      !hierarchyScopes.includes(binding.scope) ||
      typeof binding.role !== "string" ||
      binding.role.length === 0 ||
      binding.role.length > 512 ||
      !Array.isArray(binding.members) ||
      binding.members.length === 0 ||
      binding.members.some((member) =>
        typeof member !== "string" || member.length === 0 || member.length > 1_024) ||
      (binding.conditionDigestSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(binding.conditionDigestSha256 || ""))
    ) {
      fail("FIXED_GOVERNANCE_INHERITED_IAM_INVALID", "Inherited storage IAM was malformed.");
    }
    const members = [...binding.members].sort();
    if (new Set(members).size !== members.length) {
      fail("FIXED_GOVERNANCE_INHERITED_IAM_INVALID", "Inherited storage IAM repeated a principal.");
    }
    if (!inspector) {
      return {
        scope: binding.scope,
        role: binding.role,
        members,
        conditionDigestSha256: binding.conditionDigestSha256,
      };
    }
    if (
      !Array.isArray(binding.roleIncludedPermissions) ||
      binding.roleIncludedPermissions.some((permission) => typeof permission !== "string") ||
      !/^[a-f0-9]{64}$/.test(binding.rolePermissionDigestSha256 || "")
    ) {
      fail("FIXED_GOVERNANCE_INHERITED_IAM_INVALID", "The inspector role evidence was malformed.");
    }
    return {
      scope: binding.scope,
      role: binding.role,
      members,
      conditionDigestSha256: binding.conditionDigestSha256,
      roleIncludedPermissions: [...binding.roleIncludedPermissions].sort(),
      rolePermissionDigestSha256: binding.rolePermissionDigestSha256,
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(normalized.map((binding) => canonicalJson(binding))).size !== normalized.length) {
    fail("FIXED_GOVERNANCE_INHERITED_IAM_INVALID", "Inherited storage IAM repeated a binding.");
  }
  return assertInheritedStorageBindingsSafe(normalized);
};

const normalizedInheritedDigest = (bindings) => sha256(canonicalJson(bindings));

const assertInheritedStorageBindingsSafe = (bindings) => {
  const exceptionMembers = new Set([
    ISOLATED_CUTOVER_CONTRACT.inspectorPrincipal,
    ISOLATED_CUTOVER_CONTRACT.migrationWriterPrincipal,
  ]);
  for (const binding of bindings) {
    const inspectorBinding =
      binding.scope === PROJECT_SCOPE &&
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
        "FIXED_GOVERNANCE_INSPECTOR_ROLE_DRIFT",
        "The fixed inspector role or binding changed.",
      );
    }
    if (
      !inspectorBinding &&
      binding.members.some((member) => exceptionMembers.has(member))
    ) {
      fail(
        "FIXED_GOVERNANCE_EXCEPTION_INHERITED_ACCESS",
        "An isolation exception has inherited storage access.",
      );
    }
  }
  return bindings;
};

export const validateFixedGovernanceSnapshot = ({ snapshot, now = Date.now() }) => {
  requireExactKeys(
    snapshot,
    SNAPSHOT_KEYS,
    "FIXED_GOVERNANCE_SNAPSHOT_SCHEMA",
    "fixed governance snapshot",
  );
  for (const field of ["capturedAt", "collectionStartedAt", "collectionCompletedAt"]) {
    requireIsoTimestamp(snapshot[field], "FIXED_GOVERNANCE_SNAPSHOT_TIME", field);
  }
  const started = Date.parse(snapshot.collectionStartedAt);
  const completed = Date.parse(snapshot.collectionCompletedAt);
  const normalizedInheritedBindings = Array.isArray(snapshot.inheritedBindings) &&
    Array.isArray(snapshot.hierarchyScopes)
    ? normalizeSnapshotInheritedBindings(
        snapshot.inheritedBindings,
        snapshot.hierarchyScopes,
      )
    : null;
  if (
    snapshot.schemaVersion !== "hushh-tech-storage-fixed-governance-snapshot-v1" ||
    snapshot.project !== PROJECT ||
    snapshot.projectNumber !== PROJECT_NUMBER ||
    !Number.isSafeInteger(snapshot.collectionDurationMs) ||
    snapshot.collectionDurationMs < 0 ||
    snapshot.collectionDurationMs > MAXIMUM_COLLECTION_MS ||
    completed - started !== snapshot.collectionDurationMs ||
    snapshot.capturedAt !== snapshot.collectionCompletedAt ||
    !Number.isSafeInteger(now) ||
    completed > now ||
    now - completed > MAXIMUM_COLLECTION_MS ||
    !Array.isArray(snapshot.hierarchyScopes) ||
    snapshot.hierarchyScopes[0] !== PROJECT_SCOPE ||
    snapshot.hierarchyScopes.at(-1) !== ORGANIZATION_SCOPE ||
    new Set(snapshot.hierarchyScopes).size !== snapshot.hierarchyScopes.length ||
    normalizedInheritedBindings === null ||
    canonicalJson(snapshot.inheritedBindings) !== canonicalJson(normalizedInheritedBindings) ||
    snapshot.inheritedBindingsDigestSha256 !==
      normalizedInheritedDigest(normalizedInheritedBindings)
  ) {
    fail("FIXED_GOVERNANCE_SNAPSHOT_INVALID", "The fixed governance snapshot was stale or malformed.");
  }
  requireSha256(
    snapshot.inheritedBindingsDigestSha256,
    "FIXED_GOVERNANCE_SNAPSHOT_INVALID",
    "inherited IAM digest",
  );
  requireSha256(
    snapshot.snapshotDigestSha256,
    "FIXED_GOVERNANCE_SNAPSHOT_INVALID",
    "governance snapshot digest",
  );
  validateZeroGrantPolicyEvidence(snapshot.policyEvidence);
  if (
    snapshot.snapshotDigestSha256 !==
      calculateSelfBoundDigest(snapshot, "snapshotDigestSha256")
  ) {
    fail("FIXED_GOVERNANCE_SNAPSHOT_INVALID", "The fixed governance snapshot digest changed.");
  }
  return snapshot;
};

export const collectFixedStorageGovernanceSnapshot = async ({
  client = new FixedStorageGovernanceReadClient(),
  now,
} = {}) => {
  if (!(client instanceof FixedStorageGovernanceReadClient)) {
    fail("FIXED_GOVERNANCE_CLIENT_REQUIRED", "The concrete fixed governance read client is required.");
  }
  const clock = resolveClock(now);
  const startedMs = clock();
  if (!Number.isSafeInteger(startedMs) || startedMs < 0) {
    fail("FIXED_GOVERNANCE_CLOCK_INVALID", "The governance collection start time is invalid.");
  }
  const hierarchyScopes = await client.readHierarchy();
  const [scopePolicies, migrationPolicy] = await Promise.all([
    Promise.all(hierarchyScopes.map(async (scope) => ({
      scope,
      ...(await client.readScopePolicy(scope)),
    }))),
    client.readMigrationServiceAccountPolicy(),
  ]);
  const normalizedByScope = scopePolicies.map(({ scope, value }) => ({
    scope,
    bindings: normalizePolicyBindings(
      value,
      scope,
      "FIXED_GOVERNANCE_POLICY_INVALID",
    ),
  }));
  const migrationBindings = normalizePolicyBindings(
    migrationPolicy.value,
    `serviceAccounts/${MIGRATION_SERVICE_ACCOUNT}`,
    "FIXED_MIGRATION_SERVICE_ACCOUNT_POLICY_INVALID",
  );
  const roles = [...new Set(
    normalizedByScope.flatMap(({ bindings }) => bindings.map(({ role }) => role)),
  )].sort();
  if (roles.length > MAXIMUM_ROLES) {
    fail("FIXED_GOVERNANCE_ROLE_LIMIT", "The fixed hierarchy exceeded its role bound.");
  }
  const roleEntries = await Promise.all(roles.map(async (role) => {
    const response = await client.readRole(role, hierarchyScopes);
    return [role, normalizeRole(role, response.value)];
  }));
  const permissionsByRole = new Map(roleEntries);
  const inheritedBindings = normalizedByScope
    .flatMap(({ bindings }) => bindings)
    .filter(({ role }) =>
      permissionsByRole.get(role).some((permission) => permission.startsWith("storage.")))
    .map((binding) => {
      if (binding.role !== ISOLATED_CUTOVER_CONTRACT.inspectorRole) return binding;
      const includedPermissions = permissionsByRole.get(binding.role);
      return {
        ...binding,
        roleIncludedPermissions: includedPermissions,
        rolePermissionDigestSha256: sha256(canonicalJson(includedPermissions)),
      };
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  assertInheritedStorageBindingsSafe(inheritedBindings);
  const projectPolicy = scopePolicies.find(({ scope }) => scope === PROJECT_SCOPE);
  if (!projectPolicy) {
    fail("FIXED_PROJECT_POLICY_MISSING", "The fixed project policy was not collected.");
  }
  const operatorStorageAdminBindingCount = inheritedBindings
    .filter((binding) =>
      binding.members.includes(OPERATOR_PRINCIPAL)).length;
  const migrationTokenCreatorBindingCount = migrationBindings.filter((binding) =>
    binding.role === "roles/iam.serviceAccountTokenCreator" &&
    binding.members.includes(OPERATOR_PRINCIPAL)).length;
  const completedMs = clock();
  const durationMs = completedMs - startedMs;
  if (
    !Number.isSafeInteger(completedMs) ||
    completedMs < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAXIMUM_COLLECTION_MS
  ) {
    fail("FIXED_GOVERNANCE_COLLECTION_DURATION", "The governance collection exceeded five minutes.");
  }
  const capturedAt = new Date(completedMs).toISOString();
  const policyEvidence = {
    schemaVersion: ZERO_GRANT_POLICY_EVIDENCE_SCHEMA,
    capturedAt,
    project: PROJECT,
    operatorPrincipal: OPERATOR_PRINCIPAL,
    migrationServiceAccount: MIGRATION_SERVICE_ACCOUNT,
    projectPolicyFileDigestSha256: sha256(projectPolicy.bytes),
    projectPolicyCanonicalDigestSha256: sha256(canonicalJson(projectPolicy.value)),
    migrationServiceAccountPolicyFileDigestSha256: sha256(migrationPolicy.bytes),
    migrationServiceAccountPolicyCanonicalDigestSha256:
      sha256(canonicalJson(migrationPolicy.value)),
    operatorStorageAdminBindingCount,
    migrationTokenCreatorBindingCount,
    evidenceDigestSha256: null,
  };
  policyEvidence.evidenceDigestSha256 = calculateSelfBoundDigest(
    policyEvidence,
    "evidenceDigestSha256",
  );
  validateZeroGrantPolicyEvidence(policyEvidence);
  const snapshot = {
    schemaVersion: "hushh-tech-storage-fixed-governance-snapshot-v1",
    capturedAt,
    collectionStartedAt: new Date(startedMs).toISOString(),
    collectionCompletedAt: capturedAt,
    collectionDurationMs: durationMs,
    project: PROJECT,
    projectNumber: PROJECT_NUMBER,
    hierarchyScopes,
    inheritedBindings,
    inheritedBindingsDigestSha256: normalizedInheritedDigest(inheritedBindings),
    policyEvidence,
    snapshotDigestSha256: null,
  };
  snapshot.snapshotDigestSha256 = calculateSelfBoundDigest(snapshot, "snapshotDigestSha256");
  return validateFixedGovernanceSnapshot({ snapshot, now: completedMs });
};

export const assertFixedGovernanceMatchesApprovedKnownSix = ({ snapshot, approved }) => {
  const approvedDigests = new Set(
    approved?.buckets?.map((bucket) => bucket.inheritedIamEvidenceDigestSha256),
  );
  const approvedCounts = new Set(
    approved?.buckets?.map((bucket) => bucket.inheritedStorageIamBindingCount),
  );
  if (
    approvedDigests.size !== 1 ||
    !approvedDigests.has(snapshot.inheritedBindingsDigestSha256) ||
    approvedCounts.size !== 1 ||
    !approvedCounts.has(snapshot.inheritedBindings.length)
  ) {
    fail(
      "INHERITED_IAM_MUTATED_AFTER_APPROVAL",
      "Live project, folder, or organization storage IAM changed after approval.",
    );
  }
  return snapshot;
};

export const assertFixedGovernanceUnchanged = (before, after) => {
  if (
    before.inheritedBindingsDigestSha256 !== after.inheritedBindingsDigestSha256 ||
    before.policyEvidence.projectPolicyCanonicalDigestSha256 !==
      after.policyEvidence.projectPolicyCanonicalDigestSha256 ||
    before.policyEvidence.migrationServiceAccountPolicyCanonicalDigestSha256 !==
      after.policyEvidence.migrationServiceAccountPolicyCanonicalDigestSha256
  ) {
    fail("GOVERNANCE_CHANGED_DURING_COPY", "IAM governance changed during the copy window.");
  }
  return true;
};
