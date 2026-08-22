import { readFile } from "node:fs/promises";

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

type CandidateManifest = {
  target_project: string;
  deployment_state: string;
  required_registry_state: string;
  target_auth: string;
  cors_policy: string;
  cache_policy: string;
  base_branch_allowlist: string[];
  repository_allowlist: string[];
  source_files: Array<{ sha256: string }>;
  source: {
    current_version: number;
    manifest_version: number;
    live_bundle_sha256: string;
  };
  traffic_30d: { status_2xx: number; status_4xx: number };
  target_contract: { signature: string; delivery: string };
  blockers: unknown[];
  execute?: boolean;
};

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
      ["source digest", (value) => { value.source_files[0].sha256 = "0".repeat(64); }],
      ["bundle digest", (value) => { value.source.live_bundle_sha256 = "0".repeat(64); }],
      ["version parity", (value) => { value.source.current_version = value.source.manifest_version; }],
      ["traffic success", (value) => { value.traffic_30d.status_2xx = 56; value.traffic_30d.status_4xx = 0; }],
      ["signature optional", (value) => { value.target_contract.signature = "optional"; }],
      ["private key", (value) => { value.target_contract.delivery = "private key"; }],
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
