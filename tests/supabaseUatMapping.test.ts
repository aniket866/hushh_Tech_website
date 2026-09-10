import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const manifestPath = path.join(root, "migration/contracts/supabase-uat-mapping.v1.json");

describe("Supabase to UAT mapping contract", () => {
  it("keeps every active dependency classified and fully reachable", () => {
    const output = execFileSync(process.execPath, ["scripts/ci/verify-supabase-uat-mapping.mjs"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(output).toContain("ACTIVE_UNMAPPED_COUNT = 0");
    expect(output).toContain("MAPPING_VERIFY = PASS");
  });

  it("does not introduce Supabase runtime credentials into the UAT target", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.target.supabase_runtime_credentials).toBe(false);
    expect(manifest.target.gcp_project).toBe("hushh-tech-uat");
    expect(manifest.target.cloud_run_service).toBe("hushh-tech-website");
    expect(manifest.dependencies.every((dependency: { source_project: string }) =>
      dependency.source_project === "ibsisfnjxeowvdtvgzff")).toBe(true);
  });
});
