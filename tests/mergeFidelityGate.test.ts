import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The merge-fidelity orchestrator.
 *
 * The detector it drives is ported unchanged from hushh-labs/hushh-research and tested there.
 * What is new here is the wiring and the escape hatch: upstream reads an `intentional-revert`
 * label and a pull-request body through `gh`, neither of which exists inside a Cloud Build, so
 * the acknowledgement is a commit trailer instead. These tests cover that substitution and the
 * orchestrator's own verdict logic — including the rule that a pass which could not finish is
 * reported as a failure to check, never as a clean result.
 */

const ROOT = resolve(__dirname, "..");
const SCRIPTS = ["scripts/ci/check-merge-fidelity.sh", "scripts/git/check-merge-regression.sh",
  "scripts/git/scan-pr-merges-for-regression.sh"];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** Four long, unique lines — the detector ignores anything short, blank, or comment-shaped. */
const LANDED = [
  "const retryBudgetMilliseconds = 180000;",
  "if (!Number.isFinite(previousClose)) return null;",
  "await refreshQuoteCacheWithSingleFlight(symbols);",
  "throw new Error('quote provider returned no usable rows');",
].join("\n");

const ORIGINAL = [
  "const retryBudget = 1;",
  "let previousClose = 0;",
  "await refreshEverythingEveryTime();",
  "return [];",
].join("\n");

let workspace: string | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const write = (cwd: string, file: string, body: string) => writeFileSync(join(cwd, file), `${body}\n`);

const commit = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
};

/**
 * A repository where `main` landed a change to app.js and the branch then put the old content
 * back. The branch is a descendant of main's tip, so freshness is satisfied and only fidelity
 * can see the loss — loss mode B.
 */
const buildRepo = ({ revert, ack }: { revert: boolean; ack?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "fidelity-"));
  workspace = dir;

  git(dir, "init", "--quiet");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  write(dir, "app.js", ORIGINAL);
  commit(dir, "initial");

  git(dir, "checkout", "--quiet", "-b", "feature");
  write(dir, "unrelated.js", "export const unrelated = true;");
  commit(dir, "branch work");

  git(dir, "checkout", "--quiet", "main");
  write(dir, "app.js", LANDED);
  commit(dir, "fix(quotes): stop inventing prices when the provider is silent");

  git(dir, "checkout", "--quiet", "feature");
  git(dir, "merge", "--quiet", "--no-edit", "main");
  if (revert) {
    write(dir, "app.js", ORIGINAL);
    commit(dir, ack ? `chore: restore app.js\n\nMerge-Regression-Ack: ${ack}` : "chore: restore app.js");
  }

  // The orchestrator compares against origin/main, so give it one that points at this repo.
  git(dir, "remote", "add", "origin", dir);
  git(dir, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");

  for (const script of SCRIPTS) {
    mkdirSync(join(dir, script.replace(/\/[^/]+$/, "")), { recursive: true });
    copyFileSync(join(ROOT, script), join(dir, script));
  }
  return dir;
};

const run = (cwd: string, env: Record<string, string> = {}) => {
  try {
    const stdout = execFileSync("bash", ["scripts/ci/check-merge-fidelity.sh"], {
      cwd,
      env: { ...GIT_ENV, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("merge fidelity gate", () => {
  it("finds content the base landed and the branch put back", () => {
    // Freshness passes here — the branch contains main's tip. Only a content check can see it.
    const dir = buildRepo({ revert: true });
    expect(git(dir, "merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");

    const result = run(dir);
    expect(result.output).toContain("possible dropped work");
    expect(result.output).toContain("app.js");
    expect(result.code).toBe(0); // advisory by default
  });

  it("fails the step on findings in block mode", () => {
    const dir = buildRepo({ revert: true });
    expect(run(dir, { MERGE_FIDELITY_MODE: "block" }).code).toBe(1);
  });

  it("stands down when a commit on the branch declares the removal deliberate", () => {
    // Upstream's hatch is a PR label read through `gh`. A Cloud Build has neither, so the
    // acknowledgement has to live somewhere the build can actually see: the commit itself.
    const dir = buildRepo({ revert: true, ack: "rolling back the bad ticker fallback on purpose" });
    const result = run(dir, { MERGE_FIDELITY_MODE: "block" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("findings acknowledged");
    expect(result.output).toContain("rolling back the bad ticker fallback on purpose");
  });

  it("reports clean when the branch kept what the base landed", () => {
    const dir = buildRepo({ revert: false });
    const result = run(dir);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Merge fidelity: clean");
  });

  it("skips the content passes rather than flooding a branch that is merely behind", () => {
    // Every file the base gained would answer "missing" on a behind branch. That is the freshness
    // gate's finding, and it blocks; repeating it here as dozens of false positives would only
    // teach people to ignore this check.
    const dir = buildRepo({ revert: false });
    git(dir, "checkout", "--quiet", "-B", "stale", "HEAD~2");
    const result = run(dir);
    expect(result.output).toContain("PASSES B and C skipped");
    expect(result.output).toContain("Merge fidelity: clean");
  });

  it("calls a pass that could not finish INCONCLUSIVE instead of clean", () => {
    // A detector that dies before printing looks exactly like one that found nothing. It must not.
    const dir = buildRepo({ revert: true });
    for (const stub of ["scripts/git/check-merge-regression.sh", "scripts/git/scan-pr-merges-for-regression.sh"]) {
      writeFileSync(join(dir, stub), "#!/usr/bin/env bash\nexit 3\n");
    }
    const result = run(dir, { MERGE_FIDELITY_MODE: "block" });
    expect(result.output).toContain("INCONCLUSIVE");
    expect(result.output).not.toContain("Merge fidelity: clean");
    expect(result.code).toBe(1);
  });

  it("refuses to run at all when the base ref cannot be resolved", () => {
    const dir = buildRepo({ revert: true });
    const result = run(dir, { MERGE_FIDELITY_BASE_REF: "origin/nope" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Could not resolve");
  });
});
