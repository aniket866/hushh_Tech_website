import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Hushh Research UAT deployment contract", () => {
  const uat = read(".github/workflows/deploy-uat.yml");
  const production = read(".github/workflows/deploy-prod.yml");
  const ci = read(".github/workflows/ci.yml");
  const queue = read(".github/workflows/queue-validation.yml");
  const smoke = read(".github/workflows/main-post-merge-smoke.yml");

  it("pins UAT to the shared Research Firebase authority and exact callback", () => {
    expect(uat).toContain("HUSHH_RESEARCH_FIREBASE_PROJECT_ID: hushh-pda");
    expect(uat).toContain("HUSHH_RESEARCH_API_BASE_URL: https://api.uat.hushh.ai");
    expect(uat).toContain("HUSHH_RESEARCH_WEB_BASE_URL: https://uat.one.hushh.ai");
    expect(uat).toContain("HUSHH_RESEARCH_AUDIENCE: hushh-tech-uat");
    expect(uat).toContain(
      "HUSHH_RESEARCH_REDIRECT_URI: https://uat.hushhtech.com/auth/hushh-research/callback"
    );
  });

  it("mounts product credentials only in UAT", () => {
    const bindings = [
      "HUSHH_RESEARCH_DEVELOPER_TOKEN=hushh-tech-uat-research-developer-token:latest",
      "HUSHH_RESEARCH_CONNECTOR_PRIVATE_KEY=hushh-tech-uat-research-x25519-private-key:latest",
      "HUSHH_RESEARCH_FIREBASE_API_KEY=hushh-tech-uat-research-firebase-api-key:latest",
      "HUSHH_RESEARCH_FIREBASE_APP_ID=hushh-tech-uat-research-firebase-app-id:latest",
    ];
    for (const binding of bindings) {
      expect(uat).toContain(binding);
      expect(production).not.toContain(binding);
      expect(production).not.toContain(binding.split("=")[1].replace(":latest", ""));
      expect(production).not.toContain(`${binding.split("=")[0]}=`);
    }
  });

  it("hard-disables production and deterministic build lanes", () => {
    expect(production).toContain('HUSHH_RESEARCH_CLIENT_ENABLED: "false"');
    expect(production).toContain("HUSHH_RESEARCH_CLIENT_ENABLED=false");
    expect(ci).toContain('HUSHH_RESEARCH_CLIENT_ENABLED: "false"');
    expect(smoke).toContain('HUSHH_RESEARCH_CLIENT_ENABLED: "false"');
  });

  it("requires a nonempty UAT cohort before enablement", () => {
    expect(uat).toContain("HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST");
    expect(uat).toContain(
      "HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST is required when the UAT Research client is enabled."
    );
  });

  it("runs and retains the live disabled-client smoke proof", () => {
    expect(uat).toContain("scripts/smoke-hushh-research-client.mjs");
    expect(uat).toContain("uat-hushh-research-client-smoke");
    expect(uat).toContain("/tmp/uat-hushh-research-client-smoke.json");
  });

  it("captures and restores the previously serving UAT revision on failure", () => {
    expect(uat).toContain("group: deploy-uat");
    expect(uat).not.toContain("group: deploy-uat-${{");
    expect(uat).toContain("id: predeploy-state");
    expect(uat).toContain("/tmp/uat-predeploy-state.json");
    expect(uat).toContain(
      "if: failure() && steps.predeploy-state.outputs.revision != ''"
    );
    expect(uat).toContain(
      '--to-revisions="${captured_revision}=100"'
    );
    expect(uat).toContain("/tmp/uat-rollback-state.json");
    expect(uat).toContain("uat-revision-safety");
    expect(uat).toContain('select((.percent // 0) == 100)');
    expect(uat).toContain("positive_traffic_targets");

    const smokeSteps = [
      "Smoke OAuth startup on deployed host",
      "Verify sensitive NDA gate on deployed host",
      "Verify Research client contract",
    ];
    const uploadSteps = [
      "Upload UAT smoke artifact",
      "Upload UAT sensitive NDA gate artifact",
      "Upload UAT Research client smoke artifact",
      "Upload UAT predeploy and release evidence",
    ];
    const rollbackIndex = uat.indexOf(
      "- name: Restore captured revision after a failed deploy, smoke, or proof upload"
    );
    expect(rollbackIndex).toBeGreaterThan(-1);

    for (const stepName of smokeSteps) {
      const stepIndex = uat.indexOf(`- name: ${stepName}`);
      expect(stepIndex).toBeGreaterThan(-1);
      expect(stepIndex).toBeLessThan(rollbackIndex);
      const nextStepIndex = uat.indexOf("\n      - ", stepIndex + 1);
      const stepBlock = uat.slice(
        stepIndex,
        nextStepIndex === -1 ? uat.length : nextStepIndex
      );
      expect(stepBlock).not.toContain("continue-on-error:");
    }

    for (const stepName of uploadSteps) {
      const stepIndex = uat.indexOf(`- name: ${stepName}`);
      expect(stepIndex).toBeGreaterThan(-1);
      expect(stepIndex).toBeLessThan(rollbackIndex);
    }
    expect(uat.indexOf("- name: Upload UAT rollback evidence")).toBeGreaterThan(
      rollbackIndex,
    );
  });

  it("binds the served UAT revision to one exact full Git SHA", () => {
    expect(uat).toContain("DEPLOY_COMMIT_SHA=${deploy_sha}");
    expect(uat).toContain(
      "--update-labels=\"deploy-env=uat,deploy-commit=${deploy_sha},deploy-tag=uat-${short_sha},deploy-execution=${deploy_execution}\"",
    );
    expect(uat).toContain("- name: Verify exact UAT release identity");
    expect(uat).toContain('select(.name == "DEPLOY_COMMIT_SHA")');
    expect(uat).toContain("$SMOKE_BASE_URL/api/release");
    expect(uat).toContain("/tmp/uat-release-identity.json");

    const identityIndex = uat.indexOf("- name: Verify exact UAT release identity");
    const oauthIndex = uat.indexOf("- name: Smoke OAuth startup on deployed host");
    const rollbackIndex = uat.indexOf(
      "- name: Restore captured revision after a failed deploy, smoke, or proof upload",
    );
    expect(identityIndex).toBeGreaterThan(-1);
    expect(identityIndex).toBeLessThan(oauthIndex);
    expect(identityIndex).toBeLessThan(rollbackIndex);
  });

  it("checks out full Git history in migration-aware validation lanes", () => {
    for (const workflow of [ci, queue]) {
      for (const job of ["gcp-service-foundation", "web-validation"]) {
        const match = workflow.match(
          new RegExp(`(?:^|\\n)  ${job}:\\n[\\s\\S]*?(?=\\n  [a-z0-9-]+:\\n|$)`),
        );
        expect(match).not.toBeNull();
        const jobBlock = match?.[0] ?? "";
        expect(jobBlock).toContain("uses: actions/checkout@v4");
        expect(jobBlock).toContain("fetch-depth: 0");
      }
    }
  });

  it("propagates every pinned Research value into Cloud Run", () => {
    const runtimeValues = [
      "HUSHH_RESEARCH_API_BASE_URL",
      "HUSHH_RESEARCH_WEB_BASE_URL",
      "HUSHH_RESEARCH_AUDIENCE",
      "HUSHH_RESEARCH_REDIRECT_URI",
      "HUSHH_RESEARCH_FIREBASE_PROJECT_ID",
      "HUSHH_RESEARCH_FIREBASE_AUTH_DOMAIN",
      "HUSHH_RESEARCH_DEVELOPER_APP_ID",
    ];
    for (const name of runtimeValues) {
      expect(uat).toContain(`${name}=\${${name}}`);
    }
  });

  it("binds cohort variables after entering the UAT environment", () => {
    expect(uat).toContain("name: UAT – hushh-tech");
    expect(uat).toMatch(
      /environment:\n\s+name: UAT – hushh-tech\n\s+url:[^\n]+\n\s+env:\n\s+HUSHH_RESEARCH_CLIENT_ENABLED:/
    );
  });

  it("refuses drifted Research bindings and proves production is hard off", () => {
    expect(production).toContain("group: deploy-production");
    expect(production).toContain("Refuse drifted Research bindings in production");
    expect(production).toContain("Verify Research client remains absent in production");
    expect(production).toContain("prod-hushh-research-client-smoke");
    expect(production).toContain('startswith("HUSHH_RESEARCH_")');
  });
});
