import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The branch-freshness gate, exercised in the shapes CI actually produces.
 *
 * This gate is the reason a deploy cannot silently ship a tree that is missing work already on
 * `main`. Every case below is one where an earlier or more naive implementation reported green:
 * the detached HEAD every Cloud Build checkout has, the shallow single-branch clone both Cloud
 * Build and actions/checkout make by default, and an unresolvable base ref that `git rev-parse`
 * answers by echoing the ref name back.
 */

const SCRIPT = resolve(__dirname, "../scripts/git/check-main-sync.sh");

let root: string;
let upstream: string;

/** Deterministic identity and no global config, so a developer's ~/.gitconfig cannot change a result. */
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string, body: string) => {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `add ${file}`);
};

/** Runs the gate and returns its exit code and combined output rather than throwing on failure. */
const runGate = (cwd: string, env: Record<string, string> = {}) => {
  try {
    const stdout = execFileSync("sh", ["scripts/git/check-main-sync.sh"], {
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

/** Puts the gate inside a checkout that does not otherwise contain it. */
const installGate = (cwd: string) => {
  mkdirSync(join(cwd, "scripts/git"), { recursive: true });
  copyFileSync(SCRIPT, join(cwd, "scripts/git/check-main-sync.sh"));
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "freshness-"));
  upstream = join(root, "upstream");

  // main: c1 -> c3.  feature: c1 -> c2, so feature is one commit behind main.
  mkdirSync(upstream);
  git(upstream, "init", "--quiet");
  git(upstream, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(upstream, "base.txt", "c1\n");
  git(upstream, "checkout", "--quiet", "-b", "feature");
  commit(upstream, "feature.txt", "c2\n");
  git(upstream, "checkout", "--quiet", "main");
  commit(upstream, "landed.txt", "c3 — the work a stale branch would ship without\n");
  // Serving a clone over file:// is what lets the clones below be genuinely shallow.
  git(upstream, "config", "uploadpack.allowfilter", "true");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A full clone of `feature`, on a branch, with a complete history. The easy case. */
const fullCheckout = (name: string, branch: string) => {
  const dir = join(root, name);
  execFileSync("git", ["clone", "--quiet", `file://${upstream}`, "--branch", branch, dir], {
    env: GIT_ENV,
  });
  installGate(dir);
  return dir;
};

describe("branch freshness gate", () => {
  it("passes a branch that already contains the base tip", () => {
    const dir = fullCheckout("fresh", "main");
    const result = runGate(dir);
    expect(result.code).toBe(0);
    expect(result.output).toContain("contains the latest origin/main");
  });

  it("blocks a branch that is behind the base, and says by how much", () => {
    const dir = fullCheckout("behind", "feature");
    const result = runGate(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("behind origin/main by 1 commit(s)");
  });

  it("reports the same finding without failing in warn mode", () => {
    const dir = fullCheckout("behind-warn", "feature");
    const result = runGate(dir, { MAIN_SYNC_MODE: "warn" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("behind origin/main by 1 commit(s)");
  });

  it("still checks a detached HEAD in a shallow single-branch clone", () => {
    // Every Cloud Build checkout is exactly this: depth 1, one branch, no branch name. The
    // upstream implementation exits 0 on a detached HEAD, which here would mean the gate never
    // once ran in the environment it was ported for.
    const dir = join(root, "cloudbuild-shape");
    execFileSync(
      "git",
      ["clone", "--quiet", "--depth", "1", "--branch", "feature", `file://${upstream}`, dir],
      { env: GIT_ENV },
    );
    git(dir, "checkout", "--detach", "--quiet", "HEAD");
    installGate(dir);

    expect(git(dir, "branch", "--show-current")).toBe("");

    const result = runGate(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("(detached)");
    expect(result.output).toContain("behind origin/main");
  });

  it("resolves the base through an explicit refspec, not the clone's configured one", () => {
    // A single-branch clone's refspec names only `feature`, so a bare `git fetch origin main`
    // lands the base in FETCH_HEAD and never writes refs/remotes/origin/main.
    const dir = join(root, "single-branch");
    execFileSync(
      "git",
      ["clone", "--quiet", "--single-branch", "--branch", "feature", `file://${upstream}`, dir],
      { env: GIT_ENV },
    );
    installGate(dir);
    expect(git(dir, "config", "--get", "remote.origin.fetch")).not.toContain("main");

    const result = runGate(dir);
    expect(result.code).toBe(1);
    expect(result.output).toContain("behind origin/main by 1 commit(s)");
  });

  it("fails rather than passes when the base branch does not exist", () => {
    // `git rev-parse no/such-ref` prints the ref back on stdout before it fails. Read through a
    // `|| echo ""` that looks exactly like a resolved commit, and the comparison silently passes.
    const dir = fullCheckout("missing-base", "feature");
    const result = runGate(dir, { MAIN_SYNC_BRANCH: "does-not-exist" });
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("contains the latest");
  });

  it("refuses an unrecognised mode instead of guessing one", () => {
    const dir = fullCheckout("bad-mode", "feature");
    expect(runGate(dir, { MAIN_SYNC_MODE: "advisory" }).code).toBe(1);
  });
});
