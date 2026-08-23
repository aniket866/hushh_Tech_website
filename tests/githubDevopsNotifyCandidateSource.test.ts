import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseAndValidateGithubDevopsNotifyManifest,
  validateGithubDevopsNotifyCandidate,
} from "../scripts/gcp/migration/validate-github-devops-notify-candidate.mjs";

const repoRoot = new URL("../", import.meta.url);
const manifestUrl = new URL(
  "cloud-run/hushh-tech-app-services/registry/candidates.github-devops-notify.v1.json",
  repoRoot,
);
const CANDIDATE_BOOTSTRAP_SOURCE = [
  'import { __testing } from "./handlers/github-devops-notify.js";',
  "void __testing.createGithubDevopsNotifyCandidateWithTrustAnchor;",
  "",
].join("\n");

type CandidateManifest = {
  target_project: string;
  deployment_state: string;
  required_registry_state: string;
  target_auth: string;
  cors_policy: string;
  cache_policy: string;
  base_branch_allowlist: string[];
  repository_allowlist: string[];
  recipient_group_resource: string;
  source_files: Array<{ sha256: string }>;
  source: {
    current_version: number;
    manifest_version: number;
    live_bundle_sha256: string;
  };
  traffic_30d: { status_2xx: number; status_4xx: number };
  target_contract: { signature: string; delivery: string };
  detached_approval: {
    trust_anchor_state: string;
    trust_anchor_path: string;
    trust_anchor_file_sha256: string;
    handler_path: string;
    manifest_path: string;
    manifest_self_digest: string;
    reviewed_commit: string;
    reviewed_tree: string;
  };
  runtime_byte_lock: Record<string, string>;
  service_executable_closure: {
    src_inventory_digest: string;
    boot_graph_digest: string;
    src_inventory: Array<{ path: string; bytes: number; sha256: string }>;
    boot_reachable: string[];
    boot_edges: Array<{ from: string; specifier: string; to: string | null }>;
  };
  blockers: unknown[];
  execute?: boolean;
};

async function copyValidatorFixture() {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "github-devops-notify-validator-"),
  );
  const manifest = JSON.parse(
    await readFile(manifestUrl, "utf8"),
  ) as CandidateManifest & {
    source_files: Array<{ path: string }>;
  };
  const paths = new Set([
    "cloud-run/hushh-tech-app-services/registry/candidates.github-devops-notify.v1.json",
    "migration/evidence/supabase-current-live-function-bundles.v2.json",
    "migration/evidence/supabase-function-traffic-30d.v1.json",
    "migration/evidence/edge-function-terminal-matrix.v1.json",
    ...manifest.source_files.map(({ path: sourcePath }) => sourcePath),
    ...Object.keys(manifest.runtime_byte_lock),
    ...manifest.service_executable_closure.src_inventory.map(
      ({ path: sourcePath }) => sourcePath,
    ),
  ]);
  for (const relativePath of paths) {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(new URL(relativePath, repoRoot), destination);
  }
  return fixtureRoot;
}

describe("default-off GitHub DevOps notification candidate", () => {
  it("binds exact checked-in source, live-v2, traffic, terminal, registry, and runtime bytes", async () => {
    await expect(
      validateGithubDevopsNotifyCandidate({ repoRoot: repoRoot.pathname }),
    ).resolves.toEqual({
      slug: "github-devops-notify",
      frozen: true,
      wired: false,
    });
  });

  it("rejects every security, source, traffic, blocker, and activation forgery", async () => {
    const original = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as CandidateManifest;
    const attacks: Array<[string, (value: CandidateManifest) => void]> = [
      ["production target", (value) => { value.target_project = "hushh-tech-prod"; }],
      ["runtime activation", (value) => { value.deployment_state = "ACTIVE"; }],
      ["registry activation", (value) => { value.required_registry_state = "PORTED_AND_VERIFIED"; }],
      ["public auth", (value) => { value.target_auth = "none"; }],
      ["wildcard CORS", (value) => { value.cors_policy = "*"; }],
      ["public cache", (value) => { value.cache_policy = "public, max-age=3600"; }],
      ["master branch", (value) => { value.base_branch_allowlist = ["main", "master"]; }],
      ["repository widening", (value) => { value.repository_allowlist.push("attacker/repo"); }],
      ["recipient redirect", (value) => { value.recipient_group_resource = "groups/attacker-notify"; }],
      ["source digest", (value) => { value.source_files[0].sha256 = "0".repeat(64); }],
      ["bundle digest", (value) => { value.source.live_bundle_sha256 = "0".repeat(64); }],
      ["version parity", (value) => { value.source.current_version = value.source.manifest_version; }],
      ["traffic success", (value) => { value.traffic_30d.status_2xx = 56; value.traffic_30d.status_4xx = 0; }],
      ["signature optional", (value) => { value.target_contract.signature = "optional"; }],
      ["private key", (value) => { value.target_contract.delivery = "private key"; }],
      ["approval activation", (value) => { value.detached_approval.trust_anchor_state = "PROVISIONED"; }],
      ["trust anchor path", (value) => { value.detached_approval.trust_anchor_path = "attacker.json"; }],
      ["trust anchor digest", (value) => { value.detached_approval.trust_anchor_file_sha256 = "0".repeat(64); }],
      ["handler path", (value) => { value.detached_approval.handler_path = "src/attacker.js"; }],
      ["manifest path", (value) => { value.detached_approval.manifest_path = "attacker.json"; }],
      ["manifest self digest", (value) => { value.detached_approval.manifest_self_digest = "0".repeat(64); }],
      ["reviewed commit", (value) => { value.detached_approval.reviewed_commit = "1".repeat(40); }],
      ["reviewed tree", (value) => { value.detached_approval.reviewed_tree = "2".repeat(40); }],
      ["handler byte lock", (value) => { value.runtime_byte_lock[value.detached_approval.handler_path] = "0".repeat(64); }],
      ["service entrypoint byte lock", (value) => { value.runtime_byte_lock["cloud-run/hushh-tech-app-services/src/server.js"] = "0".repeat(64); }],
      ["src inventory digest", (value) => { value.service_executable_closure.src_inventory_digest = "0".repeat(64); }],
      ["boot graph digest", (value) => { value.service_executable_closure.boot_graph_digest = "0".repeat(64); }],
      ["src inventory", (value) => { value.service_executable_closure.src_inventory.pop(); }],
      ["boot reachable", (value) => { value.service_executable_closure.boot_reachable.push(value.detached_approval.handler_path); }],
      ["boot edge", (value) => { value.service_executable_closure.boot_edges.push({ from: "attacker.js", specifier: "./attacker.js", to: "attacker.js" }); }],
      ["blocker removed", (value) => { value.blockers.pop(); }],
      ["blocker reordered", (value) => { value.blockers.reverse(); }],
      ["unknown key", (value) => { value.execute = true; }],
    ];
    for (const [name, mutate] of attacks) {
      const candidate = structuredClone(original);
      mutate(candidate);
      expect(
        () => parseAndValidateGithubDevopsNotifyManifest(JSON.stringify(candidate)),
        name,
      ).toThrow(/canonical digest drift/);
    }
  });

  it("rejects Docker CMD, added bootstrap, transitive import, and dependency-lock mutations", async () => {
    const attacks: Array<{
      name: string;
      mutate: (fixtureRoot: string) => Promise<void>;
      error: RegExp;
    }> = [
      {
        name: "Docker CMD bootstrap",
        mutate: async (fixtureRoot) => {
          const dockerfilePath = path.join(
            fixtureRoot,
            "cloud-run/hushh-tech-app-services/Dockerfile",
          );
          const dockerfile = await readFile(dockerfilePath, "utf8");
          await writeFile(
            dockerfilePath,
            dockerfile.replace(
              'CMD ["node", "src/server.js"]',
              'CMD ["node", "src/candidate-bootstrap.js"]',
            ),
          );
          await writeFile(
            path.join(
              fixtureRoot,
              "cloud-run/hushh-tech-app-services/src/candidate-bootstrap.js",
            ),
            CANDIDATE_BOOTSTRAP_SOURCE,
          );
        },
        error: /Dockerfile: runtime byte drift/,
      },
      {
        name: "new candidate bootstrap",
        mutate: async (fixtureRoot) => {
          await writeFile(
            path.join(
              fixtureRoot,
              "cloud-run/hushh-tech-app-services/src/candidate-bootstrap.js",
            ),
            CANDIDATE_BOOTSTRAP_SOURCE,
          );
        },
        error: /executable src inventory or boot graph drift/,
      },
      {
        name: "transitive candidate import",
        mutate: async (fixtureRoot) => {
          await appendFile(
            path.join(
              fixtureRoot,
              "cloud-run/hushh-tech-app-services/src/config.js",
            ),
            '\nimport "./handlers/github-devops-notify.js";\n',
          );
        },
        error: /transitively runtime reachable/,
      },
      {
        name: "dependency lock",
        mutate: async (fixtureRoot) => {
          await appendFile(
            path.join(
              fixtureRoot,
              "cloud-run/hushh-tech-app-services/package-lock.json",
            ),
            "\n",
          );
        },
        error: /package-lock\.json: runtime byte drift/,
      },
    ];
    for (const attack of attacks) {
      const fixtureRoot = await copyValidatorFixture();
      try {
        await attack.mutate(fixtureRoot);
        await expect(
          validateGithubDevopsNotifyCandidate({ repoRoot: fixtureRoot }),
          attack.name,
        ).rejects.toThrow(attack.error);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects duplicate and escaped-equivalent activation, CORS, cache, and blocker keys", async () => {
    const raw = await readFile(manifestUrl, "utf8");
    const attacks = [
      raw.replace(
        '"deployment_state": "DEFAULT_OFF",',
        '"deployment_state": "DEFAULT_OFF", "deployment_state": "ACTIVE",',
      ),
      raw.replace(
        '"cors_policy": "forbidden",',
        '"cors_policy": "forbidden", "cors_policy": "*",',
      ),
      raw.replace(
        '"cache_policy": "private, no-store",',
        '"cache_policy": "private, no-store", "cache_policy": "public",',
      ),
      raw.replace(
        '"code": "SOURCE_BUNDLE_VERSION_UNBOUND",',
        '"code": "SOURCE_BUNDLE_VERSION_UNBOUND", "code": "REMOVED",',
      ),
      raw.replace(
        '"deployment_state": "DEFAULT_OFF",',
        String.raw`"deployment_state": "DEFAULT_OFF", "\u0064eployment_state": "ACTIVE",`,
      ),
    ];
    for (const attack of attacks) {
      expect(() => parseAndValidateGithubDevopsNotifyManifest(attack)).toThrow(
        /Duplicate JSON object key/,
      );
    }
  });
});
