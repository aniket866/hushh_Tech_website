import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONTRACT = Object.freeze({
  schema_version: 1,
  classifier_id: "hushh-tech-supabase-retirement-candidate-classifier",
  mode: "MACHINE_ONLY_DEFAULT_OFF",
  required_flag: "--machine-evaluate",
  base_commit: "1dbbd2a41d82322908322647773e45a9cf178313",
  base_tree: "dc027e2768b3d77ecdae82c37f1ed89c704f4d33",
  expected_functions: 112,
  evaluation_time_utc: "2026-08-21T18:03:38.344Z",
  maximum_traffic_lag_hours: 24,
  caller_non_runtime_exclusions: Object.freeze([
    "scripts/ci/generate-no-hybrid-route-inventory.mjs",
  ]),
  inputs: Object.freeze({
    manifest: Object.freeze({
      path: "migration/manifests/supabase-retirement.v1.json",
      sha256:
        "5cb75195047119f412dfa58359c12bce6202de16818a44fa3e364a5160576b47",
    }),
    historical_source: Object.freeze({
      path: "migration/evidence/supabase-live-function-bundles.v1.json",
      sha256:
        "3ae1b5b8225347cee63cb8e42fdfe744e8f905ee7b3a9d2c4eccee3ae2c81bd4",
    }),
    current_source: Object.freeze({
      path: "migration/evidence/supabase-current-live-function-bundles.v2.json",
      sha256:
        "54d9535f80d3954902da8f99cf84c46609cd7d971d6344c16704bad5e0963703",
    }),
    traffic: Object.freeze({
      path: "migration/evidence/supabase-function-traffic-30d.v1.json",
      sha256:
        "5db78b99f880423c88528817ca422ab862aa1a42f93699e37b0e4ce03fc90ac0",
    }),
    runtime_policy: Object.freeze({
      path: "scripts/ci/no-hybrid-runtime-policy.json",
      sha256:
        "7e6240c341c3a388e63e43e5d7459de722f339b19a1610d1216ac73a40ccbb4f",
    }),
  }),
  executable_roots: Object.freeze([
    "scripts/ci/check-supabase-retirement-manifest.mjs",
    "scripts/ci/check-supabase-current-function-bundle-evidence.mjs",
    "scripts/ci/check-supabase-function-traffic-evidence.mjs",
  ]),
  executable_closure: Object.freeze({
    "scripts/ci/capture-supabase-current-function-bundles.mjs": Object.freeze({
      oid: "241dac19a90cd3992b743e7e1266f2820f7d81a5",
      sha256:
        "e234705516ead1d03090ac068f69eb098ba2b79887a419681285ec39e54d9c36",
      dependencies: Object.freeze([]),
    }),
    "scripts/ci/check-supabase-current-function-bundle-evidence.mjs":
      Object.freeze({
        oid: "1a9e7b0a62605862477ab0a4e8a4f303b4a836b3",
        sha256:
          "7a824ac9ccab0de9fd91d01afe4c7d3d24f394060c03718891312ffc1f15c9ba",
        dependencies: Object.freeze([
          "scripts/ci/capture-supabase-current-function-bundles.mjs",
          "scripts/ci/check-supabase-retirement-manifest.mjs",
          "scripts/ci/generate-supabase-current-function-bundle-evidence.mjs",
        ]),
      }),
    "scripts/ci/check-supabase-function-traffic-evidence.mjs": Object.freeze({
      oid: "03990d0e73557bb35ddc1427a6626e3588b20edd",
      sha256:
        "fd4171160826c0b157bd0a066b3043b61c30069a5d28f34033a85e1542dfe2a4",
      dependencies: Object.freeze([
        "scripts/ci/generate-supabase-function-traffic-evidence.mjs",
        "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs",
      ]),
    }),
    "scripts/ci/check-supabase-retirement-manifest.mjs": Object.freeze({
      oid: "85c22ef61e1aa220278435d3df0125995242434a",
      sha256:
        "5e2cc953debe0c54cfbe69fc2fa563548475c7202e1e362440072f7ecbe01457",
      dependencies: Object.freeze([
        "scripts/ci/check-supabase-function-traffic-evidence.mjs",
        "scripts/ci/generate-supabase-function-traffic-evidence.mjs",
        "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs",
        "scripts/ci/generate-supabase-retirement-function-registry.mjs",
      ]),
    }),
    "scripts/ci/generate-supabase-current-function-bundle-evidence.mjs":
      Object.freeze({
        oid: "d82a89a3eef5096d5f459c46769692347959cb19",
        sha256:
          "b328360de8f0b82aa304878baddcd5a00b21000be7ec6bf924073e8df611f387",
        dependencies: Object.freeze([
          "scripts/ci/capture-supabase-current-function-bundles.mjs",
        ]),
      }),
    "scripts/ci/generate-supabase-function-traffic-evidence.mjs": Object.freeze(
      {
        oid: "6a0f32d6e6dc84afe03a3617123f9261683d4fb6",
        sha256:
          "265a078df6895b6568bb206ccdd3922637503d4e2fe6e62cae138ac8502b10ee",
        dependencies: Object.freeze([]),
      },
    ),
    "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs":
      Object.freeze({
        oid: "769b92bdcbfbea2c9e05f7d33905b4b01242342b",
        sha256:
          "35eb33b00a1dd79ef8da6ee35cd5480123dc037c1c444e47e4eb78f54a07ac43",
        dependencies: Object.freeze([]),
      }),
    "scripts/ci/generate-supabase-retirement-function-registry.mjs":
      Object.freeze({
        oid: "d09372ad6be80a8371837904ddd88936f8e55217",
        sha256:
          "49949e11e51d94c6a877f696cced496b59a616e69239eca852b6eab3bbde55c3",
        dependencies: Object.freeze([]),
      }),
  }),
  executable_closure_sha256:
    "b9f4bf2d5dc84e9c99daffafe906bef4aec9a1d4a852660670e0732317a22d4a",
  caller_corpus_sha256:
    "acf444bd02954a45729fcb4fd03f500270fcda5bab22978735d19bb19e7b8b91",
  caller_graph_sha256:
    "6f6bcb1f7a8cbfc72e03e86edcac79981631831c2e75376e7e35e7c353df8a2f",
});

const MUST_PORT = "MUST_PORT";
const BLOCKED = "BLOCKED";
const ELIGIBLE = "ELIGIBLE_FOR_OWNER_AND_LEGAL_REVIEW";
const APPROVALS = Object.freeze({
  owner: "REQUIRED_NOT_GRANTED",
  legal: "REQUIRED_NOT_GRANTED",
});
export const SECURITY_RETIREMENT_410_CONTRACT = Object.freeze({
  slug: "get-secrets",
  owner_group: "security-retirement",
  final_disposition: "RETIRE_WITH_410",
  gcp_owner: "cloud-run:hushh-tech-identity-api",
  auth_mode: "none_feature_retired",
  migration_method: "do_not_port_return_410_feature_retired",
  parity_check: "always_410_feature_retired_with_no_secret_payload",
  response_status: 410,
  response_code: "FEATURE_RETIRED",
  secret_payload_allowed: false,
});
const OPTIONAL_SECURITY_RETIREMENT_RESPONSE_KEYS = new Set([
  "response_status",
  "response_code",
  "secret_payload_allowed",
]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".dart",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".kts",
  ".mjs",
  ".py",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const compareUtf8 = (left, right) =>
  Buffer.compare(
    Buffer.from(String(left), "utf8"),
    Buffer.from(String(right), "utf8"),
  );

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUtf8)
      .map((key) => [key, stableValue(value[key])]),
  );
};

export const stableJson = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const gitBlobOid = (bytes) =>
  crypto
    .createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readGitObject(root, relativePath) {
  return git(root, ["show", `${CONTRACT.base_commit}:${relativePath}`], null);
}

function assertPinnedBase(root) {
  const observedCommit = git(root, [
    "rev-parse",
    `${CONTRACT.base_commit}^{commit}`,
  ]).trim();
  const observedTree = git(root, [
    "rev-parse",
    `${CONTRACT.base_commit}^{tree}`,
  ]).trim();
  if (
    observedCommit !== CONTRACT.base_commit ||
    observedTree !== CONTRACT.base_tree
  ) {
    throw new Error("EXECUTABLE_BASE_OBJECT_MISMATCH");
  }
  try {
    git(root, [
      "merge-base",
      "--is-ancestor",
      CONTRACT.base_commit,
      "HEAD",
    ]);
  } catch {
    throw new Error("EXECUTABLE_BASE_NOT_REACHABLE_FROM_HEAD");
  }
}

function resolveModuleDependency(modulePath, specifier) {
  if (specifier.startsWith("node:")) return null;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error("EXECUTABLE_NON_BUILTIN_DEPENDENCY");
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(modulePath), specifier),
  );
  if (
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved) ||
    !resolved.endsWith(".mjs")
  ) {
    throw new Error("EXECUTABLE_DEPENDENCY_PATH_DRIFT");
  }
  return resolved;
}

function findDeclarationEnd(source, start) {
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error("EXECUTABLE_IMPORT_PARSE_INCOMPLETE");
  return end + 1;
}

function extractModuleSpecifierRecords(modulePath, bytes) {
  const source = bytes.toString("utf8");
  if (Buffer.from(source, "utf8").compare(bytes) !== 0) {
    throw new Error("EXECUTABLE_MODULE_NOT_UTF8");
  }
  const records = [];
  const declarationPattern = /(^|\n)[\t ]*(import|export)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    const declarationStart = match.index + match[1].length;
    const keywordEnd =
      match.index + match[0].lastIndexOf(match[2]) + match[2].length;
    const afterKeyword = source.slice(keywordEnd).trimStart();
    if (match[2] === "import" && afterKeyword.startsWith("(")) continue;
    const declarationEnd = findDeclarationEnd(source, declarationStart);
    const declaration = source.slice(declarationStart, declarationEnd);
    const fromMatch = /\bfrom\s*(["'])([^"']+)\1\s*;?\s*$/.exec(declaration);
    const sideEffectMatch = /^\s*import\s*(["'])([^"']+)\1\s*;?\s*$/.exec(
      declaration,
    );
    const specifierMatch = fromMatch ?? sideEffectMatch;
    if (!specifierMatch) {
      if (match[2] === "import") {
        throw new Error("EXECUTABLE_IMPORT_PARSE_INCOMPLETE");
      }
      continue;
    }
    const specifier = specifierMatch[2];
    const quoted = `${specifierMatch[1]}${specifier}${specifierMatch[1]}`;
    const quoteOffset = declaration.lastIndexOf(quoted);
    if (quoteOffset < 0) throw new Error("EXECUTABLE_IMPORT_PARSE_INCOMPLETE");
    const start = declarationStart + quoteOffset + 1;
    records.push({
      specifier,
      dependency: resolveModuleDependency(modulePath, specifier),
      start,
      end: start + specifier.length,
    });
  }

  const dynamicPattern = /\bimport\s*\(/g;
  for (const match of source.matchAll(dynamicPattern)) {
    const tail = source.slice(match.index);
    const literal = /^import\s*\(\s*(["'])([^"']+)\1\s*\)/.exec(tail);
    if (!literal) throw new Error("EXECUTABLE_DYNAMIC_IMPORT_NOT_LITERAL");
    const quoted = `${literal[1]}${literal[2]}${literal[1]}`;
    const quoteOffset = literal[0].indexOf(quoted);
    const start = match.index + quoteOffset + 1;
    records.push({
      specifier: literal[2],
      dependency: resolveModuleDependency(modulePath, literal[2]),
      start,
      end: start + literal[2].length,
    });
  }
  return records.sort((left, right) => left.start - right.start);
}

export function digestExecutableClosureContract(roots, closure) {
  return sha256(
    stableJson({
      roots: [...roots].sort(compareUtf8),
      modules: Object.fromEntries(
        Object.entries(closure)
          .sort(([left], [right]) => compareUtf8(left, right))
          .map(([modulePath, pin]) => [
            modulePath,
            {
              oid: pin.oid,
              sha256: pin.sha256,
              dependencies: [...pin.dependencies].sort(compareUtf8),
            },
          ]),
      ),
    }),
  );
}

function parsePinnedTreeRecord(root, modulePath, pin) {
  const output = git(root, [
    "ls-tree",
    CONTRACT.base_commit,
    "--",
    modulePath,
  ]).trim();
  const match = /^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/.exec(output);
  if (
    !match ||
    match[1] !== "100644" ||
    match[2] !== "blob" ||
    match[3] !== pin.oid ||
    match[4] !== modulePath
  ) {
    throw new Error("EXECUTABLE_GIT_OBJECT_PATH_OR_MODE_DRIFT");
  }
}

export function verifyExecutableClosure(
  root,
  {
    roots = CONTRACT.executable_roots,
    closure = CONTRACT.executable_closure,
    expectedDigest = CONTRACT.executable_closure_sha256,
  } = {},
) {
  assertPinnedBase(root);
  const absoluteRoot = path.resolve(root);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    fs.realpathSync(absoluteRoot) !== absoluteRoot
  ) {
    throw new Error("EXECUTABLE_ROOT_PATH_DRIFT");
  }
  if (digestExecutableClosureContract(roots, closure) !== expectedDigest) {
    throw new Error("EXECUTABLE_CLOSURE_CONTRACT_DIGEST_MISMATCH");
  }

  const pinnedPaths = Object.keys(closure).sort(compareUtf8);
  const moduleRecords = new Map();
  for (const modulePath of pinnedPaths) {
    if (
      modulePath !== path.posix.normalize(modulePath) ||
      modulePath.startsWith("/") ||
      modulePath.includes("..")
    ) {
      throw new Error("EXECUTABLE_PINNED_PATH_DRIFT");
    }
    const pin = closure[modulePath];
    parsePinnedTreeRecord(root, modulePath, pin);
    const gitBytes = readGitObject(root, modulePath);
    if (sha256(gitBytes) !== pin.sha256 || gitBlobOid(gitBytes) !== pin.oid) {
      throw new Error("EXECUTABLE_GIT_OBJECT_SUBSTITUTION");
    }
    const records = extractModuleSpecifierRecords(modulePath, gitBytes);
    const dependencies = [
      ...new Set(records.map((record) => record.dependency).filter(Boolean)),
    ].sort(compareUtf8);
    if (
      stableJson(dependencies) !==
      stableJson([...pin.dependencies].sort(compareUtf8))
    ) {
      throw new Error("EXECUTABLE_DEPENDENCY_EDGE_DRIFT");
    }

    const absolutePath = path.join(absoluteRoot, ...modulePath.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      throw new Error("EXECUTABLE_WORKTREE_MODULE_MISSING");
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(absolutePath) !== absolutePath
    ) {
      throw new Error("EXECUTABLE_WORKTREE_PATH_OR_SYMLINK_DRIFT");
    }
    const worktreeBytes = fs.readFileSync(absolutePath);
    if (
      sha256(worktreeBytes) !== pin.sha256 ||
      gitBlobOid(worktreeBytes) !== pin.oid ||
      !worktreeBytes.equals(gitBytes)
    ) {
      throw new Error("EXECUTABLE_WORKTREE_SUBSTITUTION");
    }
    moduleRecords.set(modulePath, { bytes: gitBytes, records });
  }

  const discovered = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (discovered.has(modulePath)) continue;
    if (!moduleRecords.has(modulePath)) {
      throw new Error("EXECUTABLE_CLOSURE_MODULE_MISSING");
    }
    discovered.add(modulePath);
    pending.push(...closure[modulePath].dependencies);
  }
  if (
    stableJson([...discovered].sort(compareUtf8)) !== stableJson(pinnedPaths)
  ) {
    throw new Error("EXECUTABLE_CLOSURE_MISSING_OR_EXTRA_MODULE");
  }
  return {
    closure_sha256: expectedDigest,
    modules: moduleRecords,
    roots: [...roots],
  };
}

function buildVerifiedModuleDataUrl(modulePath, verified, memo, visiting) {
  if (memo.has(modulePath)) return memo.get(modulePath);
  if (visiting.has(modulePath)) throw new Error("EXECUTABLE_CLOSURE_CYCLE");
  visiting.add(modulePath);
  const moduleRecord = verified.modules.get(modulePath);
  if (!moduleRecord) throw new Error("EXECUTABLE_CLOSURE_MODULE_MISSING");
  let source = moduleRecord.bytes.toString("utf8");
  const replacements = [];
  for (const record of moduleRecord.records) {
    if (!record.dependency) continue;
    replacements.push({
      start: record.start,
      end: record.end,
      value: buildVerifiedModuleDataUrl(
        record.dependency,
        verified,
        memo,
        visiting,
      ),
    });
  }
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    source = `${source.slice(0, replacement.start)}${replacement.value}${source.slice(replacement.end)}`;
  }
  visiting.delete(modulePath);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}#${encodeURIComponent(modulePath)}`;
  memo.set(modulePath, dataUrl);
  return dataUrl;
}

async function importVerifiedCheckerModules(verified) {
  const memo = new Map();
  const visiting = new Set();
  const urls = Object.fromEntries(
    verified.roots.map((modulePath) => [
      modulePath,
      buildVerifiedModuleDataUrl(modulePath, verified, memo, visiting),
    ]),
  );
  const retirement = await import(
    urls["scripts/ci/check-supabase-retirement-manifest.mjs"]
  );
  const current = await import(
    urls["scripts/ci/check-supabase-current-function-bundle-evidence.mjs"]
  );
  const traffic = await import(
    urls["scripts/ci/check-supabase-function-traffic-evidence.mjs"]
  );
  return {
    validateManifest: retirement.validateManifest,
    validateLiveFunctionBundleEvidence:
      retirement.validateLiveFunctionBundleEvidence,
    validateCurrentFunctionBundleEvidence:
      current.validateCurrentFunctionBundleEvidence,
    validateFunctionTrafficEvidence: traffic.validateFunctionTrafficEvidence,
  };
}

function assertDigest(label, bytes, expected) {
  const observed = sha256(bytes);
  if (observed !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, observed ${observed}.`,
    );
  }
  return observed;
}

function uniqueIndex(entries, label, slugOf = (entry) => entry.slug) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const index = new Map();
  for (const entry of entries) {
    const slug = slugOf(entry);
    if (typeof slug !== "string" || !slug || index.has(slug)) {
      throw new Error(`${label} contains a missing or duplicate slug.`);
    }
    index.set(slug, entry);
  }
  return index;
}

function exactSlugSet(expected, actual, label) {
  const left = [...expected].sort(compareUtf8);
  const right = [...actual].sort(compareUtf8);
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(
      `${label} does not match the exact frozen 112-function registry.`,
    );
  }
}

function isWithin(candidate, prefix) {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function runtimeFilesAtBase(root, policy) {
  const sourceRoots = policy.source_surfaces.map((entry) => entry.path);
  const excluded = [
    ...policy.generated_artifact_roots,
    ...policy.classified_non_runtime.map((entry) => entry.path),
    ...CONTRACT.caller_non_runtime_exclusions,
  ];
  const output = git(root, [
    "ls-tree",
    "-r",
    CONTRACT.base_commit,
    "--",
    ...sourceRoots,
  ]);
  const records = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/.exec(line);
      if (!match) throw new Error(`Unexpected git tree record: ${line}`);
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    })
    .filter((entry) => entry.type === "blob")
    .filter((entry) => !excluded.some((prefix) => isWithin(entry.path, prefix)))
    .filter((entry) =>
      SOURCE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()),
    )
    .sort((left, right) => compareUtf8(left.path, right.path));
  return records;
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function addUnique(target, value) {
  const key = stableJson(value);
  if (!target.some((entry) => stableJson(entry) === key)) target.push(value);
}

function scanCallerFile({ file, source, slugSet, callers, unresolved }) {
  const staticPath =
    /\/functions\/v1\/([a-z0-9][a-z0-9-]*)(?=[/?#`'"\s)\]}]|$)/giu;
  for (const match of source.matchAll(staticPath)) {
    const slug = match[1].toLowerCase();
    if (!slugSet.has(slug)) continue;
    addUnique(callers.get(slug), {
      path: file.path,
      line: lineNumberAt(source, match.index),
      kind: "STATIC_FUNCTION_ROUTE",
    });
  }

  const staticInvoke =
    /\.functions\s*\.invoke\s*\(\s*([`'"])([a-z0-9][a-z0-9-]*)\1/giu;
  for (const match of source.matchAll(staticInvoke)) {
    const slug = match[2].toLowerCase();
    if (!slugSet.has(slug)) continue;
    addUnique(callers.get(slug), {
      path: file.path,
      line: lineNumberAt(source, match.index),
      kind: "STATIC_SDK_INVOKE",
    });
  }

  const dynamicPatterns = [
    { kind: "DYNAMIC_FUNCTION_ROUTE", regex: /\/functions\/v1\/\s*\$\{/giu },
    {
      kind: "DYNAMIC_FUNCTION_ROUTE_CONCATENATION",
      regex: /\/functions\/v1\/?[`'"]\s*\+/giu,
    },
    {
      kind: "DYNAMIC_SDK_INVOKE",
      regex:
        /\.functions\s*\.invoke\s*\(\s*(?![`'"][a-z0-9][a-z0-9-]*[`'"])/giu,
    },
  ];
  for (const pattern of dynamicPatterns) {
    for (const match of source.matchAll(pattern.regex)) {
      addUnique(unresolved, {
        path: file.path,
        line: lineNumberAt(source, match.index),
        kind: pattern.kind,
        expression_sha256: sha256(source.slice(match.index, match.index + 160)),
      });
    }
  }
}

function positiveSurfaceFlags(registryEntry, reachableCallers) {
  const text = [
    registryEntry.source.slug,
    registryEntry.auth_mode,
    registryEntry.owner_group,
    registryEntry.gcp_owner,
    registryEntry.migration_method,
    ...reachableCallers.map((entry) => entry.path),
  ]
    .join(" ")
    .toLowerCase();
  return {
    webhook: /webhook|signed[_-]callback/.test(text),
    schedule: /schedule|scheduler|cron|periodic/.test(text),
    admin: /(^|[^a-z])admin([^a-z]|$)/.test(text),
  };
}

export function buildPinnedCallerGraph({ root, policy, registryEntries }) {
  const files = runtimeFilesAtBase(root, policy);
  const slugs = registryEntries.map((entry) => entry.source.slug);
  const slugSet = new Set(slugs);
  const callers = new Map(slugs.map((slug) => [slug, []]));
  const unresolved = [];
  for (const file of files) {
    const source = readGitObject(root, file.path).toString("utf8");
    scanCallerFile({ file, source, slugSet, callers, unresolved });
  }
  for (const values of callers.values()) {
    values.sort((left, right) =>
      compareUtf8(
        `${left.path}:${left.line}:${left.kind}`,
        `${right.path}:${right.line}:${right.kind}`,
      ),
    );
  }
  unresolved.sort((left, right) =>
    compareUtf8(
      `${left.path}:${left.line}:${left.kind}`,
      `${right.path}:${right.line}:${right.kind}`,
    ),
  );
  const corpus = files.map(({ mode, oid, path: filePath }) => ({
    mode,
    oid,
    path: filePath,
  }));
  const entries = registryEntries
    .map((entry) => {
      const slug = entry.source.slug;
      const reachableCallers = callers.get(slug);
      const surfaceFlags = positiveSurfaceFlags(entry, reachableCallers);
      return {
        slug,
        reachable_callers: reachableCallers,
        unresolved_dynamic_callers: [],
        resolution_status:
          unresolved.length === 0 ? "COMPLETE" : "INCOMPLETE_DYNAMIC_CALLERS",
        surface_flags: surfaceFlags,
        surface_analysis_status: Object.values(surfaceFlags).some(Boolean)
          ? "POSITIVE_MATCH"
          : "INCOMPLETE_NO_NEGATIVE_PROOF",
        side_effect_status: "UNKNOWN_NO_AUTHORITATIVE_SEMANTIC_EVIDENCE",
        side_effects: [],
      };
    })
    .sort((left, right) => compareUtf8(left.slug, right.slug));
  const graph = {
    schema_version: 1,
    base_commit: CONTRACT.base_commit,
    runtime_policy_sha256: CONTRACT.inputs.runtime_policy.sha256,
    corpus_sha256: sha256(stableJson(corpus)),
    resolution_status:
      unresolved.length === 0 ? "COMPLETE" : "INCOMPLETE_DYNAMIC_CALLERS",
    unresolved_dynamic_callers: unresolved,
    entries,
  };
  return {
    corpus,
    graph,
    corpus_sha256: graph.corpus_sha256,
    graph_sha256: sha256(stableJson(graph)),
  };
}

export function deriveGlobalEvidenceBlockers({
  currentEvidence,
  trafficEvidence,
  currentValidation,
  trafficValidation,
}) {
  const blockers = [];
  if (!currentValidation.valid)
    blockers.push("CURRENT_SOURCE_EVIDENCE_INVALID");
  if (!trafficValidation.valid) blockers.push("TRAFFIC_EVIDENCE_INVALID");
  const assessment = currentEvidence.cutover_assessment ?? {};
  if (assessment.status !== "CUTOVER_READY_EXACT")
    blockers.push("SOURCE_CAPTURE_NOT_STABLE");
  if (assessment.metadata_end_check_status !== "PASSED_EXACT") {
    blockers.push("SOURCE_END_METADATA_CHECK_NOT_PASSED");
  }
  if (assessment.bundle_to_metadata_version_binding_status !== "PROVEN_EXACT") {
    blockers.push("SOURCE_BUNDLE_VERSION_BINDING_NOT_PROVEN");
  }
  if (
    assessment.source_revision_status !== "PROVEN" ||
    !/^[a-f0-9]{40}$/.test(assessment.source_revision ?? "")
  ) {
    blockers.push("SOURCE_REVISION_NOT_PROVEN");
  }
  if (
    trafficEvidence.unattributed_traffic_status !==
    "ZERO_UNATTRIBUTED_TRAFFIC_OBSERVED"
  ) {
    blockers.push("UNATTRIBUTED_TRAFFIC_NOT_ZERO");
  }
  const windowEnd = Date.parse(trafficEvidence.capture?.window_end_utc ?? "");
  const evaluationTime = Date.parse(CONTRACT.evaluation_time_utc);
  const lag = evaluationTime - windowEnd;
  if (
    !Number.isFinite(windowEnd) ||
    lag < 0 ||
    lag > CONTRACT.maximum_traffic_lag_hours * 60 * 60 * 1000
  ) {
    blockers.push("TRAFFIC_WINDOW_STALE_OR_FUTURE");
  }
  return [...new Set(blockers)].sort(compareUtf8);
}

function pushIf(target, condition, code) {
  if (condition) target.push(code);
}

function securityRetirementRegistryValue(registryEntry, key) {
  return key === "slug" ? registryEntry?.source?.slug : registryEntry?.[key];
}

function matchesSecurityRetirementMarker(observed, expected) {
  if (observed === expected) return true;
  if (typeof observed !== "string") return false;
  const normalized = observed.trim();
  if (typeof expected === "string") {
    return normalized.toLowerCase() === expected.toLowerCase();
  }
  if (typeof expected === "number") return normalized === String(expected);
  if (typeof expected === "boolean") {
    return normalized.toLowerCase() === String(expected);
  }
  return false;
}

function securityRetirementContractFor(registryEntry) {
  const declaredMarkers = Object.entries(SECURITY_RETIREMENT_410_CONTRACT);
  const markers = declaredMarkers.some(([key, expected]) =>
    matchesSecurityRetirementMarker(
      securityRetirementRegistryValue(registryEntry, key),
      expected,
    ),
  );
  if (!markers) return null;
  const exact = declaredMarkers.every(([key, expected]) => {
    const observed = securityRetirementRegistryValue(registryEntry, key);
    if (
      OPTIONAL_SECURITY_RETIREMENT_RESPONSE_KEYS.has(key) &&
      observed === undefined
    ) {
      return true;
    }
    return observed === expected;
  });
  return {
    exact,
    blocker: exact
      ? "SECURITY_RETIREMENT_410_TERMINAL_ONLY"
      : "SECURITY_RETIREMENT_410_CONTRACT_MISMATCH",
    contract: {
      slug: SECURITY_RETIREMENT_410_CONTRACT.slug,
      owner_group: SECURITY_RETIREMENT_410_CONTRACT.owner_group,
      final_disposition: SECURITY_RETIREMENT_410_CONTRACT.final_disposition,
      response_status: SECURITY_RETIREMENT_410_CONTRACT.response_status,
      response_code: SECURITY_RETIREMENT_410_CONTRACT.response_code,
      secret_payload_allowed:
        SECURITY_RETIREMENT_410_CONTRACT.secret_payload_allowed,
      handling: "EXPLICIT_TERMINAL_APPROVAL_ONLY",
    },
  };
}

export function classifyCandidateEntry({
  registryEntry,
  currentEntry,
  trafficEntry,
  callerEntry,
  globalBlockers = [],
}) {
  const slug = registryEntry?.source?.slug ?? null;
  if (
    !slug ||
    currentEntry?.slug !== slug ||
    trafficEntry?.slug !== slug ||
    callerEntry?.slug !== slug
  ) {
    throw new Error(
      "Candidate entry inputs must bind to the same non-empty slug.",
    );
  }
  const trafficCount = trafficEntry.request_count;
  const securityRetirement = securityRetirementContractFor(registryEntry);
  const reachableCallerSetValid = Array.isArray(callerEntry.reachable_callers);
  const reachableCallers = reachableCallerSetValid
    ? callerEntry.reachable_callers
    : [];
  const mustPortReasons = [];
  if (Number.isInteger(trafficCount) && trafficCount > 0) {
    mustPortReasons.push("ACTIVE_30_DAY_TRAFFIC");
  }
  if (reachableCallers.length > 0)
    mustPortReasons.push("REACHABLE_CALLER_PRESENT");
  if (mustPortReasons.length > 0) {
    return {
      slug,
      classification: MUST_PORT,
      reason_codes: mustPortReasons,
      traffic_request_count: trafficCount,
      reachable_callers: reachableCallers,
      approvals: APPROVALS,
      retirement_authorized: false,
    };
  }

  const blockers = [...globalBlockers];
  if (securityRetirement) blockers.push(securityRetirement.blocker);
  pushIf(blockers, trafficCount !== 0, "TRAFFIC_COUNT_NOT_PROVEN_ZERO");
  pushIf(
    blockers,
    trafficEntry.terminal_traffic_status !== "ZERO_TRAFFIC_OBSERVED",
    "ZERO_TRAFFIC_STATUS_NOT_PROVEN",
  );
  pushIf(
    blockers,
    !Array.isArray(trafficEntry.nonzero_utc_buckets) ||
      trafficEntry.nonzero_utc_buckets.length !== 0,
    "ZERO_TRAFFIC_BUCKETS_NOT_PROVEN",
  );
  pushIf(
    blockers,
    trafficEntry.deployment_manifest_match_status !== "EXACT_MANIFEST_MATCH",
    "TRAFFIC_DEPLOYMENT_SOURCE_DRIFT",
  );
  pushIf(
    blockers,
    currentEntry.capture_status !== "EXTRACTED",
    "CURRENT_SOURCE_CAPTURE_INCOMPLETE",
  );
  pushIf(
    blockers,
    currentEntry.current_version !== registryEntry.source.version ||
      currentEntry.manifest_version !== registryEntry.source.version,
    "CURRENT_SOURCE_VERSION_DRIFT",
  );
  pushIf(
    blockers,
    callerEntry.resolution_status !== "COMPLETE",
    "CALLER_GRAPH_INCOMPLETE",
  );
  pushIf(blockers, !reachableCallerSetValid, "REACHABLE_CALLER_SET_INVALID");
  pushIf(
    blockers,
    !Array.isArray(callerEntry.unresolved_dynamic_callers) ||
      callerEntry.unresolved_dynamic_callers.length > 0,
    "DYNAMIC_CALLER_UNRESOLVED",
  );
  pushIf(
    blockers,
    callerEntry.surface_analysis_status !== "COMPLETE",
    "SURFACE_ANALYSIS_INCOMPLETE",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.webhook === true,
    "WEBHOOK_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.webhook !== "boolean",
    "WEBHOOK_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.schedule === true,
    "SCHEDULE_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.schedule !== "boolean",
    "SCHEDULE_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.admin === true,
    "ADMIN_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.admin !== "boolean",
    "ADMIN_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.side_effect_status !== "NONE",
    "SIDE_EFFECT_STATUS_NOT_NONE",
  );
  pushIf(
    blockers,
    !Array.isArray(callerEntry.side_effects) ||
      callerEntry.side_effects.length > 0,
    "SIDE_EFFECT_PRESENT",
  );
  pushIf(
    blockers,
    registryEntry.migration_state !== "INVENTORY_FROZEN",
    "REGISTRY_STATE_NOT_FROZEN",
  );

  const reasonCodes = [...new Set(blockers)].sort(compareUtf8);
  return {
    slug,
    classification: reasonCodes.length === 0 ? ELIGIBLE : BLOCKED,
    reason_codes: reasonCodes,
    traffic_request_count: trafficCount,
    reachable_callers: reachableCallers,
    approvals: APPROVALS,
    retirement_authorized: false,
    ...(securityRetirement
      ? { terminal_contract: securityRetirement.contract }
      : {}),
  };
}

export function verifyPinnedBytes(inputBytes) {
  for (const [name, pin] of Object.entries(CONTRACT.inputs)) {
    if (!Buffer.isBuffer(inputBytes[name]))
      throw new Error(`Missing pinned bytes for ${name}.`);
    assertDigest(name, inputBytes[name], pin.sha256);
  }
  return true;
}

export function verifyPinnedCallerGraph(callerGraphResult) {
  const observedCorpusDigest = sha256(stableJson(callerGraphResult.corpus));
  const observedGraphDigest = sha256(stableJson(callerGraphResult.graph));
  if (
    observedCorpusDigest !== callerGraphResult.corpus_sha256 ||
    observedCorpusDigest !== CONTRACT.caller_corpus_sha256 ||
    callerGraphResult.graph?.corpus_sha256 !== observedCorpusDigest
  ) {
    throw new Error("Pinned caller corpus digest mismatch.");
  }
  if (
    observedGraphDigest !== callerGraphResult.graph_sha256 ||
    observedGraphDigest !== CONTRACT.caller_graph_sha256
  ) {
    throw new Error("Pinned caller graph digest mismatch.");
  }
  return true;
}

export function classifyPinnedInputs({
  inputBytes,
  callerGraphResult,
  validators,
  verifiedExecutableClosure,
}) {
  verifyPinnedBytes(inputBytes);
  verifyPinnedCallerGraph(callerGraphResult);
  const manifest = JSON.parse(inputBytes.manifest.toString("utf8"));
  const historicalEvidence = JSON.parse(
    inputBytes.historical_source.toString("utf8"),
  );
  const currentEvidence = JSON.parse(
    inputBytes.current_source.toString("utf8"),
  );
  const trafficEvidence = JSON.parse(inputBytes.traffic.toString("utf8"));

  const manifestValidation = validators.validateManifest(manifest);
  const historicalValidation = validators.validateLiveFunctionBundleEvidence(
    manifest,
    historicalEvidence,
  );
  const currentValidation = validators.validateCurrentFunctionBundleEvidence({
    manifest,
    historicalEvidence,
    evidence: currentEvidence,
    manifestBytes: inputBytes.manifest,
    historicalEvidenceBytes: inputBytes.historical_source,
    canonicalCheckerBytes: verifiedExecutableClosure.modules.get(
      "scripts/ci/check-supabase-retirement-manifest.mjs",
    ).bytes,
    historicalGeneratorBytes: verifiedExecutableClosure.modules.get(
      "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs",
    ).bytes,
  });
  const trafficValidation = validators.validateFunctionTrafficEvidence(
    manifest,
    historicalEvidence,
    trafficEvidence,
  );
  const validationErrors = [
    ...(manifestValidation.errors ?? []),
    ...(historicalValidation.errors ?? []),
    ...(currentValidation.errors ?? []),
    ...(trafficValidation.errors ?? []),
  ];
  if (validationErrors.length > 0) {
    throw new Error(
      `Authoritative evidence validation failed: ${validationErrors.join(" | ")}`,
    );
  }

  const registryEntries = manifest.functions;
  if (registryEntries.length !== CONTRACT.expected_functions) {
    throw new Error(
      `Expected ${CONTRACT.expected_functions} frozen functions.`,
    );
  }
  const registrySlugs = registryEntries.map((entry) => entry.source.slug);
  const currentIndex = uniqueIndex(
    currentEvidence.entries,
    "current source evidence",
  );
  const trafficIndex = uniqueIndex(trafficEvidence.entries, "traffic evidence");
  const callerIndex = uniqueIndex(
    callerGraphResult.graph.entries,
    "caller graph",
  );
  exactSlugSet(registrySlugs, currentIndex.keys(), "Current source evidence");
  exactSlugSet(registrySlugs, trafficIndex.keys(), "Traffic evidence");
  exactSlugSet(registrySlugs, callerIndex.keys(), "Caller graph");

  const globalBlockers = deriveGlobalEvidenceBlockers({
    currentEvidence,
    trafficEvidence,
    currentValidation,
    trafficValidation,
  });
  if (callerGraphResult.graph.resolution_status !== "COMPLETE") {
    globalBlockers.push("CALLER_GRAPH_GLOBAL_INCOMPLETE");
  }
  const entries = registryEntries
    .map((registryEntry) =>
      classifyCandidateEntry({
        registryEntry,
        currentEntry: currentIndex.get(registryEntry.source.slug),
        trafficEntry: trafficIndex.get(registryEntry.source.slug),
        callerEntry: callerIndex.get(registryEntry.source.slug),
        globalBlockers,
      }),
    )
    .sort((left, right) => compareUtf8(left.slug, right.slug));
  const counts = Object.fromEntries(
    [MUST_PORT, BLOCKED, ELIGIBLE].map((classification) => [
      classification,
      entries.filter((entry) => entry.classification === classification).length,
    ]),
  );
  return {
    schema_version: CONTRACT.schema_version,
    classifier_id: CONTRACT.classifier_id,
    mode: CONTRACT.mode,
    state: "EVALUATED_NO_ACTION",
    base_commit: CONTRACT.base_commit,
    base_tree: CONTRACT.base_tree,
    evaluation_time_utc: CONTRACT.evaluation_time_utc,
    input_pins: Object.fromEntries(
      Object.entries(CONTRACT.inputs).map(([name, pin]) => [
        name,
        { path: pin.path, sha256: pin.sha256 },
      ]),
    ),
    executable_closure: {
      sha256: verifiedExecutableClosure.closure_sha256,
      pinned_modules: verifiedExecutableClosure.modules.size,
      evaluated_modules: verifiedExecutableClosure.modules.size,
      evaluation_source: "VERIFIED_BASE_GIT_OBJECT_DATA_URLS",
      modules: Object.entries(CONTRACT.executable_closure)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([modulePath, pin]) => ({
          path: modulePath,
          git_blob_oid: pin.oid,
          sha256: pin.sha256,
          dependencies: [...pin.dependencies],
        })),
    },
    caller_graph: {
      corpus_sha256: callerGraphResult.corpus_sha256,
      graph_sha256: callerGraphResult.graph_sha256,
      unresolved_dynamic_callers:
        callerGraphResult.graph.unresolved_dynamic_callers,
    },
    global_blockers: [...new Set(globalBlockers)].sort(compareUtf8),
    counts,
    entries,
    owner_approval_required: true,
    legal_approval_required: true,
    serving_registry_mutated: false,
    retirement_authorized: false,
    provider_calls_performed: 0,
    files_written: 0,
  };
}

export function loadPinnedInputs(root) {
  assertPinnedBase(root);
  return Object.fromEntries(
    Object.entries(CONTRACT.inputs).map(([name, pin]) => [
      name,
      readGitObject(root, pin.path),
    ]),
  );
}

export async function runPinnedClassifier(root) {
  const verifiedExecutableClosure = verifyExecutableClosure(root);
  const validators = await importVerifiedCheckerModules(
    verifiedExecutableClosure,
  );
  const inputBytes = loadPinnedInputs(root);
  verifyPinnedBytes(inputBytes);
  const policy = JSON.parse(inputBytes.runtime_policy.toString("utf8"));
  const manifest = JSON.parse(inputBytes.manifest.toString("utf8"));
  const callerGraphResult = buildPinnedCallerGraph({
    root,
    policy,
    registryEntries: manifest.functions,
  });
  return classifyPinnedInputs({
    inputBytes,
    callerGraphResult,
    validators,
    verifiedExecutableClosure,
  });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  if (process.argv.includes("--inspect-pins")) {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const verifiedExecutableClosure = verifyExecutableClosure(root);
    const inputBytes = loadPinnedInputs(root);
    verifyPinnedBytes(inputBytes);
    const caller = buildPinnedCallerGraph({
      root,
      policy: JSON.parse(inputBytes.runtime_policy.toString("utf8")),
      registryEntries: JSON.parse(inputBytes.manifest.toString("utf8"))
        .functions,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          corpus_sha256: caller.corpus_sha256,
          graph_sha256: caller.graph_sha256,
          executable_closure_sha256: verifiedExecutableClosure.closure_sha256,
          provider_calls_performed: 0,
          files_written: 0,
        },
        null,
        2,
      )}\n`,
    );
  } else if (!process.argv.includes(CONTRACT.required_flag)) {
    process.stdout.write(
      `${JSON.stringify({
        schema_version: CONTRACT.schema_version,
        classifier_id: CONTRACT.classifier_id,
        state: "DISABLED_BY_DEFAULT",
        required_flag: CONTRACT.required_flag,
        serving_registry_mutated: false,
        retirement_authorized: false,
        provider_calls_performed: 0,
        files_written: 0,
      })}\n`,
    );
  } else {
    try {
      const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
      process.stdout.write(
        `${JSON.stringify(await runPinnedClassifier(root), null, 2)}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          schema_version: CONTRACT.schema_version,
          classifier_id: CONTRACT.classifier_id,
          state: "BLOCKED",
          error_code: "PINNED_CLASSIFIER_FAILURE",
          error_sha256: sha256(
            error instanceof Error ? error.message : String(error),
          ),
          serving_registry_mutated: false,
          retirement_authorized: false,
          provider_calls_performed: 0,
          files_written: 0,
        })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
