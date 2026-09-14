import { describe, expect, it, vi } from "vitest";

import { fetchBaseBranch, isSafeBranchName, isUsableToken } from "../scripts/ci/fetch-base-branch.mjs";

/**
 * The helper that lets a Cloud Build step reach the base branch at all.
 *
 * It exists because a build step has no credential for this repository: the trigger's clone token
 * is consumed by the source fetch, so a plain `git fetch` runs anonymously and gets a 403 now that
 * the repository is private. It therefore handles a short-lived GitHub token, and the cases below
 * are mostly about that token never escaping the child process.
 */

const okToken = async () => "ghs_exampletoken";

describe("branch names accepted for a fetch", () => {
  it("accepts ordinary branch names", () => {
    for (const name of ["main", "develop", "release/2026-09", "feat.x-1"]) {
      expect(isSafeBranchName(name)).toBe(true);
    }
  });

  it("rejects anything that could become a second argument or refspec", () => {
    // The branch is interpolated into a refspec. argv keeps a space harmless, but `--upload-pack`
    // would still be read as an option and `..` as a range.
    for (const name of ["--upload-pack=sh", "main..evil", "-main", "", "a/", "x.lock", "a b"]) {
      expect(isSafeBranchName(name)).toBe(false);
    }
  });

  it("refuses to run at all on an unsafe name", async () => {
    const git = vi.fn();
    await expect(
      fetchBaseBranch({ branch: "--upload-pack=sh", git, readToken: okToken, env: {} }),
    ).rejects.toThrow(/unsafe branch name/);
    expect(git).not.toHaveBeenCalled();
  });
});

describe("tokens accepted as a header value", () => {
  it("rejects a token carrying a newline", () => {
    // A newline in a header value is a header injection, so this is checked before it is encoded.
    expect(isUsableToken("abc\r\nX-Evil: 1")).toBe(false);
    expect(isUsableToken("abc\ndef")).toBe(false);
    expect(isUsableToken("   ")).toBe(false);
    expect(isUsableToken("ghs_ok")).toBe(true);
  });
});

describe("fetching the base branch", () => {
  const runner = (shallow: string, sha = "a".repeat(40)) => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const git = (args: string[], env: Record<string, string>) => {
      calls.push({ args, env });
      if (args[1] === "--is-shallow-repository") return shallow;
      if (args[0] === "rev-parse") return sha;
      return "";
    };
    return { git, calls };
  };

  it("writes the base into refs/remotes/origin and never puts the token in argv", async () => {
    const { git, calls } = runner("false");
    await fetchBaseBranch({ branch: "main", git, readToken: okToken, env: {} });

    const fetch = calls.find((call) => call.args[0] === "fetch")!;
    expect(fetch.args).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(fetch.args.join(" ")).not.toContain("exampletoken");
    // It travels as a child-only git config header instead.
    expect(fetch.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(fetch.env.GIT_CONFIG_VALUE_0).toContain(
      Buffer.from("x-access-token:ghs_exampletoken").toString("base64"),
    );
  });

  it("unshallows only when the clone is shallow", async () => {
    // `git merge-base --is-ancestor` walks history; on a truncated one it can deny an ancestor
    // that is one, and the gate reading that answer would report a stale branch as fresh.
    const shallow = runner("true");
    await fetchBaseBranch({ branch: "main", git: shallow.git, readToken: okToken, env: {} });
    expect(shallow.calls.find((c) => c.args[0] === "fetch")!.args).toContain("--unshallow");

    const complete = runner("false");
    await fetchBaseBranch({ branch: "main", git: complete.git, readToken: okToken, env: {} });
    expect(complete.calls.find((c) => c.args[0] === "fetch")!.args).not.toContain("--unshallow");
  });

  it("drops inherited GIT_* so ambient config cannot redirect the fetch or trace the header", async () => {
    const { git, calls } = runner("false");
    await fetchBaseBranch({
      branch: "main",
      git,
      readToken: okToken,
      env: { GIT_TRACE: "1", GIT_CONFIG_GLOBAL: "/etc/attacker", KEEP_ME: "yes" },
    });
    const fetch = calls.find((call) => call.args[0] === "fetch")!;
    expect(fetch.env.GIT_TRACE).toBeUndefined();
    expect(fetch.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(fetch.env.KEEP_ME).toBe("yes");
  });

  it("fails when the fetch leaves no resolvable ref rather than reporting success", async () => {
    const git = (args: string[]) => (args[1] === "--is-shallow-repository" ? "false" : "not-a-sha");
    await expect(fetchBaseBranch({ branch: "main", git, readToken: okToken, env: {} })).rejects.toThrow(
      /did not resolve/,
    );
  });

  it("refuses a token the provider returned with a newline in it", async () => {
    const { git } = runner("false");
    await expect(
      fetchBaseBranch({ branch: "main", git, readToken: async () => "bad\ntoken", env: {} }),
    ).rejects.toThrow();
  });
});
