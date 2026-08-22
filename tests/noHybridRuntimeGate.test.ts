import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeExecutableContent,
  loadNoHybridPolicy,
  scanNoHybridRuntime,
  validateGateWiring,
  validatePolicy,
} from "../scripts/ci/check-no-hybrid-runtime.mjs";
import {
  isForbiddenProviderHost,
  isForbiddenProviderTarget,
} from "./noHybridNetworkGuard";

const temporaryRoots: string[] = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-no-hybrid-"));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, relativePath: string, contents: string | Buffer) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function copyWiringFixture(root: string) {
  const policy = loadNoHybridPolicy();
  const paths = new Set([
    "package.json",
    "tests/noHybridNetworkGuard.ts",
    "playwright.no-hybrid.config.ts",
    "tests/noHybridNetwork.spec.ts",
    policy.required_wiring.orchestrator,
    policy.required_wiring.pull_request_workflow,
    policy.required_wiring.queue_workflow,
    policy.required_wiring.post_merge_workflow,
    ...policy.required_wiring.deploy_workflows,
    ...policy.required_wiring.runtime_dockerfiles,
    policy.frozen_compatibility_contract.registry_path,
    policy.frozen_compatibility_contract.server_path,
  ]);
  for (const relativePath of paths) {
    write(root, relativePath, fs.readFileSync(path.join(process.cwd(), relativePath)));
  }
  return policy;
}

function fixturePolicy() {
  const policy = structuredClone(loadNoHybridPolicy());
  policy.source_surfaces = [{ path: "src", kind: "fixture-runtime" }];
  policy.runtime_entrypoints = ["src/main.js"];
  policy.generated_artifact_roots = ["dist", "ios/App/App/public", "android/app/src/main/assets/public"];
  policy.classified_non_runtime = [
    { path: "migration", classification: "migration-contract-evidence" },
    { path: "tests", classification: "automated-test-evidence" },
  ];
  return policy;
}

function codes(result: ReturnType<typeof scanNoHybridRuntime>) {
  return result.violations.map((violation) => violation.code);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("fail-closed no-hybrid runtime gate", () => {
  it("accepts a clean GCP-only runtime", () => {
    const root = temporaryRoot();
    write(root, "src/main.js", `import { start } from "./runtime.js"; start();`);
    write(root, "src/runtime.js", `export const start = () => fetch("/api/profile");`);

    const result = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects SDK imports, client construction, and database/auth/storage/function calls", () => {
    const root = temporaryRoot();
    write(
      root,
      "src/main.js",
      `
        import { createClient as connect } from "@supabase/supabase-js";
        const supabaseClient = connect(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        await supabaseClient.auth.getUser();
        await supabaseClient.storage.from("documents").download("a.pdf");
        await supabaseClient.functions.invoke("stock-quotes");
        await supabaseClient.from("profiles").select("id");
        await supabaseClient.rpc("private_fn");
      `,
    );

    const result = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "PROVIDER_SDK_IMPORT",
        "PROVIDER_ENV_BINDING",
        "PROVIDER_CLIENT_ACCESS",
        "PROVIDER_CLIENT_CONSTRUCTION",
        "PROVIDER_DATA_OR_AUTH_ACCESS",
      ]),
    );
  });

  it("decodes concatenation, arrays, unicode, character codes, base64, and computed env aliases", () => {
    const samples = [
      `const a="supa"; const b="base"; const endpoint="https://tenant." + a + b + ".co"; fetch(endpoint);`,
      `const envName=["SUPA", "BASE_URL"].join(""); const env=process.env; fetch(env[envName]);`,
      `const endpoint="https://tenant.\\u0073\\u0075\\u0070\\u0061\\u0062\\u0061\\u0073\\u0065.co";`,
      `const provider=String.fromCharCode(115,117,112,97,98,97,115,101);`,
      `const endpoint=atob("aHR0cHM6Ly90ZW5hbnQuc3VwYWJhc2UuY28=");`,
      `const endpoint=Buffer.from("aHR0cHM6Ly90ZW5hbnQuc3VwYWJhc2UuY28=", "base64").toString("utf8");`,
    ];

    for (const sample of samples) {
      expect(analyzeExecutableContent(sample).violations.map((entry) => entry.code)).toContain(
        "OBFUSCATED_PROVIDER_REFERENCE",
      );
    }
  });

  it("binds raw and derived references to every retired provider project", () => {
    const policy = loadNoHybridPolicy();
    expect(policy.forbidden_project_refs).toEqual([
      "ibsisfnjxeowvdtvgzff",
      "gsqmwxqgqrgzhlhmbscg",
      "hkdlmkpqwbjnmcwlxczv",
      "jbvfjyxpjyspafqzohmi",
      "qoeqfmeimagulpzjptbj",
      "rpmzykoxqnbozgdoqbpc",
      "spmxyqxjqxcyywkapong",
    ]);

    expect(
      analyzeExecutableContent(`const project = "rpmzykoxqnbozgdoqbpc";`).violations.map(
        (entry) => entry.code,
      ),
    ).toContain("PROVIDER_PROJECT_REF");
    expect(
      analyzeExecutableContent(
        `const project = atob("aWJzaXNmbmp4ZW93dmR0dmd6ZmY=");`,
      ).violations.map((entry) => entry.code),
    ).toContain("OBFUSCATED_PROVIDER_REFERENCE");

    const drifted = structuredClone(policy);
    drifted.forbidden_project_refs.pop();
    expect(validatePolicy(drifted).map((entry) => entry.code)).toContain(
      "POLICY_PROJECT_REFS_INVALID",
    );
  });

  it("does not treat a comment or the local GCP retirement registry name as provider access", () => {
    const source = `
      // https://tenant.supabase.co must never return.
      /* process.env.SUPABASE_URL is historical documentation. */
      import { SUPABASE_RETIREMENT_FUNCTIONS } from "./supabaseRetirementFunctionRegistry.js";
      export const routeCount = SUPABASE_RETIREMENT_FUNCTIONS.length;
    `;

    expect(analyzeExecutableContent(source).violations).toEqual([]);
  });

  it("does not mistake URL slashes for comments in shell, YAML, Docker, or CSS", () => {
    const samples = [
      ["fixture.sh", "curl https://tenant.supabase.co/rest/v1/profiles"],
      ["fixture.yml", "endpoint: https://tenant.supabase.co/rest/v1/profiles"],
      ["Dockerfile", "RUN curl https://tenant.supabase.co/rest/v1/profiles"],
      ["fixture.css", "body { background: url(https://tenant.supabase.co/storage/v1/object/public/a.png); }"],
    ] as const;

    for (const [relativePath, source] of samples) {
      expect(
        analyzeExecutableContent(source, relativePath).violations.map((entry) => entry.code),
      ).toContain("PROVIDER_URL");
    }
  });

  it("rejects a public Firebase API key used as an authorization credential", () => {
    const unsafe = [
      `fetch("/functions/v1/example", { headers: { apikey: import.meta.env.VITE_FIREBASE_API_KEY } });`,
      `fetch("/functions/v1/example", { headers: { Authorization: \`Bearer \${config.FIREBASE_API_KEY}\` } });`,
      `const publicKey = import.meta.env.VITE_FIREBASE_API_KEY; fetch("/x", { headers: { Authorization: \`Bearer \${publicKey}\` } });`,
    ];
    for (const source of unsafe) {
      expect(analyzeExecutableContent(source).violations.map((entry) => entry.code)).toContain(
        "PUBLIC_FIREBASE_KEY_AS_CREDENTIAL",
      );
    }

    const safe = `
      const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
      initializeApp({ apiKey });
      fetch("/functions/v1/example", { headers: { Authorization: \`Bearer \${session.access_token}\` } });
    `;
    expect(analyzeExecutableContent(safe).violations.map((entry) => entry.code)).not.toContain(
      "PUBLIC_FIREBASE_KEY_AS_CREDENTIAL",
    );
  });

  it("rejects static and computed transitive imports into classified provider archives", () => {
    const root = temporaryRoot();
    write(
      root,
      "src/main.js",
      `const target = "../migration/provider.js"; await import(target);`,
    );
    write(
      root,
      "migration/provider.js",
      `import { createClient } from "@supabase/supabase-js"; export default createClient;`,
    );

    const result = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toContain("RUNTIME_IMPORTS_CLASSIFIED_NON_RUNTIME_CODE");
    expect(codes(result)).toContain("PROVIDER_SDK_IMPORT");
  });

  it("rejects unresolved dynamic imports before they can cross a classified boundary", () => {
    const root = temporaryRoot();
    write(
      root,
      "src/main.js",
      "const leaf = window.location.hash.slice(1); await import(`../migration/${leaf}.js`);",
    );
    write(
      root,
      "migration/provider.js",
      'import "@supabase/supabase-js";',
    );

    const result = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toContain("UNRESOLVED_DYNAMIC_RUNTIME_IMPORT");

    write(
      root,
      "src/main.js",
      "const leaf = window.location.hash.slice(1); await import(\n  `../migration/${leaf}.js`\n);",
    );
    const multiline = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });
    expect(codes(multiline)).toContain("UNRESOLVED_DYNAMIC_RUNTIME_IMPORT");
  });

  it("scans generated web/native bundles and fails when the required dist is absent", () => {
    const missingRoot = temporaryRoot();
    write(missingRoot, "src/main.js", `fetch("/api/ready");`);
    const missing = scanNoHybridRuntime({
      root: missingRoot,
      policy: fixturePolicy(),
      requireDist: true,
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });
    expect(codes(missing)).toContain("GENERATED_ARTIFACT_MISSING");

    const root = temporaryRoot();
    write(root, "src/main.js", `fetch("/api/ready");`);
    write(root, "dist/assets/app.js", `fetch(atob("aHR0cHM6Ly90ZW5hbnQuc3VwYWJhc2UuY28vcmVzdC92MS9wcm9maWxlcw=="));`);
    write(root, "ios/App/App/public/app.js", `const key=["SUPA","BASE_URL"].join("");`);
    write(root, "android/app/src/main/assets/public/app.js", `fetch("https://tenant.supabase.co/auth/v1/user");`);

    const result = scanNoHybridRuntime({
      root,
      policy: fixturePolicy(),
      requireDist: true,
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toContain("GENERATED_OBFUSCATED_PROVIDER_REFERENCE");
    expect(codes(result)).toContain("GENERATED_PROVIDER_URL");
  });

  it("scans native source even when no web build exists", () => {
    const root = temporaryRoot();
    const policy = fixturePolicy();
    policy.source_surfaces.push(
      { path: "ios", kind: "native-ios-source" },
      { path: "android", kind: "native-android-source" },
    );
    write(root, "src/main.js", `fetch("/api/ready");`);
    write(root, "ios/App/Auth.swift", `let endpoint = "https://tenant.supabase.co/auth/v1"`);
    write(root, "android/app/src/main/java/Auth.kt", `val key = System.getenv("SUPABASE_ANON_KEY")`);

    const result = scanNoHybridRuntime({
      root,
      policy,
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toEqual(expect.arrayContaining(["PROVIDER_URL", "PROVIDER_ENV_BINDING"]));
  });

  it("rejects root production dependencies and npm aliases while permitting evidence-only dev tools", () => {
    const root = temporaryRoot();
    const policy = fixturePolicy();
    policy.source_surfaces.push({ path: "package.json", kind: "runtime-manifest" });
    write(root, "src/main.js", `fetch("/api/ready");`);
    write(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { "db-client": "npm:@supabase/supabase-js@2.46.1" },
        devDependencies: { supabase: "1.219.0" },
      }),
    );

    const result = scanNoHybridRuntime({
      root,
      policy,
      validateWiring: false,
      enforceCanonicalPolicy: false,
    });

    expect(codes(result)).toContain("PROVIDER_RUNTIME_DEPENDENCY");
  });

  it("rejects attempts to classify deployable runtime as migration evidence", () => {
    const policy = fixturePolicy();
    policy.classified_non_runtime.push({
      path: "src",
      classification: "migration-contract-evidence",
    });

    expect(validatePolicy(policy).map((violation) => violation.code)).toContain(
      "POLICY_ATTEMPTS_RUNTIME_ALLOWLIST",
    );
  });

  it("freezes the complete production policy instead of trusting mutable scan roots", () => {
    const mutations = [
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.source_surfaces = [{ path: "README.md", kind: "narrowed" }];
      },
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.runtime_entrypoints = [];
      },
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.generated_artifact_roots = ["public"];
      },
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.forbidden_direct_dependencies = [];
      },
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.frozen_compatibility_contract.expected_route_count = 0;
      },
      (policy: ReturnType<typeof loadNoHybridPolicy>) => {
        policy.required_wiring.pull_request_workflow = "README.md";
      },
    ];

    for (const mutate of mutations) {
      const policy = structuredClone(loadNoHybridPolicy());
      mutate(policy);
      expect(
        validatePolicy(policy, { enforceBrowserCoverage: false }).map((entry) => entry.code),
      ).toContain("POLICY_CANONICAL_DIGEST_INVALID");
    }

    const scriptsClassification = structuredClone(loadNoHybridPolicy());
    scriptsClassification.classified_non_runtime.push({
      path: "scripts",
      classification: "migration-tooling",
    });
    expect(validatePolicy(scriptsClassification).map((entry) => entry.code)).toContain(
      "POLICY_ATTEMPTS_RUNTIME_ALLOWLIST",
    );
  });

  it("matches only the provider apex and its subdomains in the browser guard", () => {
    expect(isForbiddenProviderHost("supabase.co")).toBe(true);
    expect(isForbiddenProviderHost("tenant.supabase.co")).toBe(true);
    expect(isForbiddenProviderHost("tenant.supabase.com")).toBe(true);
    expect(isForbiddenProviderHost("tenant.supabase.in")).toBe(true);
    expect(isForbiddenProviderHost("TENANT.SUPABASE.CO.")).toBe(true);
    expect(isForbiddenProviderHost("supabase.co.attacker.example")).toBe(false);
    expect(isForbiddenProviderHost("not-supabase.co")).toBe(false);
    expect(
      isForbiddenProviderTarget(
        "https://gcp.example/api/proxy/ibsisfnjxeowvdtvgzff/functions/v1/stock-quotes",
      ),
    ).toBe(true);
  });

  it("requires exhaustive route inventory and all three authenticated fixtures", () => {
    expect(validatePolicy(loadNoHybridPolicy()).map((entry) => entry.code)).not.toContain(
      "FULL_ROUTE_AND_AUTH_BROWSER_COVERAGE",
    );

    for (const key of ["full_route_inventory", "authenticated_fixture"] as const) {
      const incomplete = structuredClone(loadNoHybridPolicy());
      incomplete.browser_coverage[key] = false;
      const observed = validatePolicy(incomplete).map((entry) => entry.code);
      expect(observed).toContain("BROWSER_COVERAGE_POLICY_INVALID");
      expect(observed).toContain("FULL_ROUTE_AND_AUTH_BROWSER_COVERAGE");
    }
  });

  it("keeps the production API loader graph statically bounded", () => {
    const result = scanNoHybridRuntime({
      root: process.cwd(),
      policy: loadNoHybridPolicy(),
      validateWiring: false,
      enforceBrowserCoverage: false,
    });

    expect(codes(result)).not.toContain("UNRESOLVED_DYNAMIC_RUNTIME_IMPORT");
  });

  it("keeps package, PR, queue, post-merge, deploy, image, and 112-route wiring fail closed", () => {
    expect(validateGateWiring(process.cwd(), loadNoHybridPolicy())).toEqual([]);
  });

  it("binds both Playwright engines in config, PR, queue, and post-merge", () => {
    const configRoot = temporaryRoot();
    const configPolicy = copyWiringFixture(configRoot);
    const configPath = "playwright.no-hybrid.config.ts";
    const config = fs
      .readFileSync(path.join(configRoot, configPath), "utf8")
      .replace('name: "webkit"', 'name: "webkit-disabled"');
    write(configRoot, configPath, config);
    expect(validateGateWiring(configRoot, configPolicy).map((entry) => entry.code)).toContain(
      "BROWSER_CONFIG_DIGEST_DRIFT",
    );

    for (const workflowPath of [
      configPolicy.required_wiring.pull_request_workflow,
      configPolicy.required_wiring.queue_workflow,
      configPolicy.required_wiring.post_merge_workflow,
    ]) {
      const root = temporaryRoot();
      const policy = copyWiringFixture(root);
      const workflow = fs
        .readFileSync(path.join(root, workflowPath), "utf8")
        .replace(
          "npx playwright install --with-deps chromium webkit",
          "npx playwright install --with-deps chromium",
        );
      write(root, workflowPath, workflow);
      expect(validateGateWiring(root, policy).map((entry) => entry.code)).toContain(
        "BROWSER_ENGINE_INSTALL_INVALID",
      );
    }
  });

  it("does not accept workflow or Docker gate markers that survive only in comments", () => {
    const workflowRoot = temporaryRoot();
    const workflowPolicy = copyWiringFixture(workflowRoot);
    const workflowPath = workflowPolicy.required_wiring.pull_request_workflow;
    const workflow = fs
      .readFileSync(path.join(workflowRoot, workflowPath), "utf8")
      .replace(
        "        run: bash scripts/ci/orchestrate.sh no-hybrid",
        "        # run: bash scripts/ci/orchestrate.sh no-hybrid",
      );
    write(workflowRoot, workflowPath, workflow);
    expect(validateGateWiring(workflowRoot, workflowPolicy).map((entry) => entry.code)).toContain(
      "AUTHORITATIVE_WORKFLOW_GATE_MISSING",
    );

    const dockerRoot = temporaryRoot();
    const dockerPolicy = copyWiringFixture(dockerRoot);
    const dockerPath = dockerPolicy.required_wiring.runtime_dockerfiles[0];
    const dockerfile = fs
      .readFileSync(path.join(dockerRoot, dockerPath), "utf8")
      .replace(
        "RUN node scripts/ci/check-no-hybrid-runtime.mjs --artifact-only --require-dist",
        "# RUN node scripts/ci/check-no-hybrid-runtime.mjs --artifact-only --require-dist",
      );
    write(dockerRoot, dockerPath, dockerfile);
    expect(validateGateWiring(dockerRoot, dockerPolicy).map((entry) => entry.code)).toContain(
      "RUNTIME_IMAGE_GATE_MISSING",
    );

    const conditionalRoot = temporaryRoot();
    const conditionalPolicy = copyWiringFixture(conditionalRoot);
    const conditionalPath = conditionalPolicy.required_wiring.pull_request_workflow;
    const conditionalWorkflow = fs
      .readFileSync(path.join(conditionalRoot, conditionalPath), "utf8")
      .replace(
        "      - name: Prove source, build, and browser are GCP-only\n",
        "      - name: Prove source, build, and browser are GCP-only\n        if: ${{ false }}\n",
      );
    write(conditionalRoot, conditionalPath, conditionalWorkflow);
    expect(validateGateWiring(conditionalRoot, conditionalPolicy).map((entry) => entry.code)).toContain(
      "AUTHORITATIVE_WORKFLOW_GATE_CONDITIONAL",
    );

    const echoRoot = temporaryRoot();
    const echoPolicy = copyWiringFixture(echoRoot);
    const echoPath = echoPolicy.required_wiring.pull_request_workflow;
    const echoWorkflow = fs
      .readFileSync(path.join(echoRoot, echoPath), "utf8")
      .replace(
        "        run: bash scripts/ci/orchestrate.sh no-hybrid",
        '        run: echo "run: bash scripts/ci/orchestrate.sh no-hybrid"',
      );
    write(echoRoot, echoPath, echoWorkflow);
    expect(validateGateWiring(echoRoot, echoPolicy).map((entry) => entry.code)).toContain(
      "AUTHORITATIVE_WORKFLOW_GATE_MISSING",
    );

    const deadJobRoot = temporaryRoot();
    const deadJobPolicy = copyWiringFixture(deadJobRoot);
    const deadJobPath = deadJobPolicy.required_wiring.pull_request_workflow;
    const deadJobWorkflow = fs
      .readFileSync(path.join(deadJobRoot, deadJobPath), "utf8")
      .replace(
        "    runs-on: ubuntu-latest\n    timeout-minutes: 35",
        "    runs-on: ubuntu-latest\n    if: ${{ github.repository == 'never/never' }}\n    timeout-minutes: 35",
      );
    write(deadJobRoot, deadJobPath, deadJobWorkflow);
    expect(validateGateWiring(deadJobRoot, deadJobPolicy).map((entry) => entry.code)).toContain(
      "AUTHORITATIVE_WORKFLOW_GATE_DISABLED",
    );
  });
});
