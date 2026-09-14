#!/usr/bin/env node
/**
 * Fetch the base branch into `refs/remotes/origin/<branch>` from inside a Cloud Build step.
 *
 * Why this is needed at all: the branch-freshness gate has to compare HEAD against the base, and a
 * Cloud Build step cannot reach the base on its own. The trigger's clone credential is consumed by
 * the source fetch and is not handed to the build steps, so a plain `git fetch origin main` runs
 * anonymously — which returns 403 now that this repository is private. Proven on build
 * 1e1f743b: "[main-sync] BLOCKED Could not fetch origin/main".
 *
 * The repository already had the answer for a different step. `prepare-repository-history.mjs`
 * mints a short-lived read token from the Cloud Build 2nd-generation connection and passes it to
 * Git as a child-process-only HTTP header. The same grant covers this
 * (`roles/cloudbuild.readTokenAccessor` on the build identity, nothing more), so this is the same
 * mechanism rather than a second credential path to audit.
 *
 * Two differences from that script, both so this can run BEFORE `npm ci`:
 *
 *   - No `googleapis` import. The ADC token comes from the metadata server over plain `fetch`,
 *     which means no node_modules and therefore no reason to install the tree before knowing
 *     whether the branch is even worth building.
 *   - It fetches a named branch rather than the tested HEAD.
 *
 * Credential discipline is copied deliberately and should stay copied: the token never appears in
 * argv, never touches disk, and nothing here serializes a caught error — a provider or git failure
 * can carry the Authorization header in its message.
 *
 * Usage:  node scripts/ci/fetch-base-branch.mjs [branch]      (default: main)
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPOSITORY = "https://github.com/hushh-labs/hushh_Tech_website.git";
const TOKEN_ENDPOINT =
  "https://cloudbuild.googleapis.com/v2/projects/hushh-tech-uat/locations/us-central1" +
  "/connections/hushh-github/repositories/hushh_Tech_website:accessReadToken";
const METADATA_TOKEN =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** A branch name git will accept, and that cannot smuggle a second refspec or an option. */
export const isSafeBranchName = (branch) =>
  typeof branch === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch) &&
  !branch.includes("..") &&
  !branch.endsWith(".lock") &&
  !branch.endsWith("/");

/** A GitHub token is only usable as a header if it cannot break out of one. */
export const isUsableToken = (token) =>
  typeof token === "string" && token.trim().length > 0 && !/[\r\n]/.test(token);

const adcToken = async () => {
  const response = await fetch(METADATA_TOKEN, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error("metadata server did not return an access token");
  const { access_token: accessToken } = await response.json();
  if (!isUsableToken(accessToken)) throw new Error("metadata server returned an unusable token");
  return accessToken;
};

const connectionReadToken = async () => {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${await adcToken()}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`connection read token request returned ${response.status}`);
  const { token } = await response.json();
  if (!isUsableToken(token)) throw new Error("connection returned an unusable read token");
  return token;
};

const runGit = (args, env) =>
  execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }).trim();

export const fetchBaseBranch = async ({
  branch = "main",
  git = runGit,
  readToken = connectionReadToken,
  env = process.env,
} = {}) => {
  if (!isSafeBranchName(branch)) throw new Error(`refusing to fetch unsafe branch name: ${branch}`);

  // Drop inherited GIT_* so no ambient config redirects the fetch or turns on tracing that would
  // print the header below.
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  gitEnv.GIT_TERMINAL_PROMPT = "0";
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = "/dev/null";

  // Validated here, not only inside the provider: this is where the value becomes an HTTP header,
  // so this is where a newline stops being a formatting question and becomes header injection.
  const token = await readToken();
  if (!isUsableToken(token)) throw new Error("read token is not usable as a header value");

  const fetchEnv = {
    ...gitEnv,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };

  // Unshallow: `git merge-base --is-ancestor` walks history, and on a truncated one it can deny an
  // ancestor that is one. A wrong answer here is worse than no answer.
  const args = ["fetch", "--no-tags", "--quiet"];
  if (git(["rev-parse", "--is-shallow-repository"], gitEnv) === "true") args.push("--unshallow");
  git([...args, REPOSITORY, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], fetchEnv);

  const sha = git(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], gitEnv);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("fetch completed but the base ref did not resolve");
  return sha;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const branch = process.argv[2] || "main";
  try {
    const sha = await fetchBaseBranch({ branch });
    console.log(`fetched origin/${branch} at ${sha.slice(0, 8)}`);
  } catch {
    // Fixed message. A git or provider error can contain the Authorization header.
    console.error(
      `could not fetch origin/${branch} through the Cloud Build connection.\n` +
        "Check that the build identity still holds roles/cloudbuild.readTokenAccessor and that the\n" +
        "hushh-github connection still has this repository linked. Do not work around this by\n" +
        "skipping the freshness gate.",
    );
    process.exitCode = 1;
  }
}
