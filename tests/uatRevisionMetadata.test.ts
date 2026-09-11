import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/deploy-uat.yml", "utf8");
const deployStep = workflow.split("      - name: Deploy to Cloud Run\n")[1]
  .split("\n      - name:")[0];
const script = deployStep.split("        run: |\n")[1]
  .split("\n").filter((line) => line.startsWith("          "))
  .map((line) => line.slice(10)).join("\n");
const sha = "68f4b67a12a5e585f591463f8d7396a67375de4c";
const staleSha = "4edb0b4cb7c27951058860835634805169e98e3c";

// Execute the actual workflow shell with gcloud replaced by an argv recorder:
// no credentials, network, deployment or source changes are involved.
function deployment(commit = sha, run = "34631956746", attempt = "1") {
  const variables = Object.fromEntries(
    [...script.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((match) => [match[1], ""]),
  );
  return spawnSync("bash", ["-c", `gcloud() { printf '%s\\0' "$@"; }\n${
    script.replaceAll("${{ steps.resolve-sha.outputs.sha }}", commit)
  }`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...variables, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt },
  });
}

function metadata(run = "34631956746", attempt = "1") {
  const result = deployment(sha, run, attempt);
  expect(result.status, result.stderr).toBe(0);
  const args = result.stdout.split("\0").filter(Boolean);
  expect(args.slice(0, 3)).toEqual(["run", "deploy", "hushh-tech-website"]);
  expect(args).toContain("--project=hushh-tech-uat");
  const labels = Object.fromEntries(args.find((arg) => arg.startsWith("--update-labels="))!
    .slice("--update-labels=".length).split(",").map((label) => label.split("=")));
  const runtimeSha = args.find((arg) => arg.startsWith("--update-env-vars="))!
    .split("|").find((entry) => entry.startsWith("DEPLOY_COMMIT_SHA="))!.split("=")[1];
  expect(labels["deploy-commit"]).toBe(sha);
  expect(runtimeSha).toBe(sha);
  return labels;
}

// Model Cloud SDK LabelChanges.Adjust / labels_util.Diff.Apply: revision
// labels are copied only when the service-level label map actually changes.
function revisionLabels(service: Record<string, string>, template: Record<string, string>, update: Record<string, string>) {
  const next = { ...service, ...update };
  const changed = Object.entries(next).some(([key, value]) => service[key] !== value);
  return changed ? next : template;
}

describe("UAT exact-SHA revision metadata", () => {
  it("repairs a stale template even when service labels already name the intended SHA", () => {
    const update = metadata();
    const { "deploy-execution": execution, ...oldUpdate } = update;
    expect(execution).toBe("34631956746-1");
    const template = { "deploy-commit": staleSha };
    // Reproduce the pre-fix no-op and prove this same fixture is repaired.
    expect(revisionLabels(oldUpdate, template, oldUpdate)["deploy-commit"]).toBe(staleSha);
    expect(revisionLabels(oldUpdate, template, update)["deploy-commit"]).toBe(sha);
  });

  it("refreshes metadata on a new run and a rerun of the same SHA", () => {
    const previous = metadata();
    for (const next of [metadata("34631956747"), metadata("34631956746", "2")]) {
      expect(next["deploy-execution"]).not.toBe(previous["deploy-execution"]);
      expect(revisionLabels(previous, { "deploy-commit": staleSha }, next)["deploy-commit"]).toBe(sha);
    }
  });

  it("sets exact metadata on the first deployment without previous labels", () => {
    expect(revisionLabels({}, {}, metadata())["deploy-commit"]).toBe(sha);
  });

  it.each([
    ["68f4b67a", "1", "1"],
    [sha, "", "1"],
    [sha, "1", ""],
    [sha, "1", "invalid"],
  ])("fails before deployment for invalid SHA/run identity (%s, %s, %s)", (commit, run, attempt) => {
    const result = deployment(commit, run, attempt);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("\0");
  });
});
