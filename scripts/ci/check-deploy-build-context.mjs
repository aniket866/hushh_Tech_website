#!/usr/bin/env node
/**
 * Every COPY source in the Dockerfile must survive .gcloudignore.
 *
 * `gcloud run deploy --source .` uploads a build context filtered by
 * .gcloudignore, then Docker builds from it. A path the Dockerfile copies but
 * .gcloudignore excludes fails only at deploy time, inside Cloud Build, with:
 *
 *   COPY failed: file not found in build context or excluded by .dockerignore
 *
 * No other CI job catches that, because no other job performs a source deploy.
 * This one does the same filtering locally and compares the two lists.
 *
 * Runs without credentials: `gcloud meta list-files-for-upload` is local.
 * If gcloud is unavailable the check skips rather than failing the build —
 * a missing tool is not evidence of a broken context.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const DOCKERFILE = process.env.DEPLOY_DOCKERFILE || "Dockerfile";

function fail(message) {
  console.error(`deploy-build-context: ${message}`);
  process.exitCode = 1;
}

function copySources(dockerfilePath) {
  const text = readFileSync(dockerfilePath, "utf8");
  // Join continuation lines so a multi-line COPY is read as one instruction.
  const joined = text.replace(/\\\r?\n/g, " ");
  const sources = [];

  for (const rawLine of joined.split("\n")) {
    const line = rawLine.trim();
    if (!/^COPY\s/i.test(line)) continue;
    // Drop the instruction keyword and any --flags (--from=, --chown=, ...).
    const tokens = line
      .slice(4)
      .trim()
      .split(/\s+/)
      .filter((token) => !token.startsWith("--"));
    // A COPY with --from=<stage> reads from an earlier build stage, not the
    // uploaded context, so it is not our problem.
    if (/--from=/i.test(line)) continue;
    // Last token is the destination.
    if (tokens.length < 2) continue;
    sources.push(...tokens.slice(0, -1));
  }

  return [...new Set(sources)];
}

function uploadContext() {
  try {
    const stdout = execFileSync("gcloud", ["meta", "list-files-for-upload", "."], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

const dockerfilePath = path.join(root, DOCKERFILE);
if (!existsSync(dockerfilePath)) {
  fail(`${DOCKERFILE} not found.`);
  process.exit(process.exitCode || 0);
}

const context = uploadContext();
if (context === null) {
  console.log("deploy-build-context: skipped (gcloud unavailable)");
  process.exit(0);
}

const sources = copySources(dockerfilePath);
if (sources.length === 0) {
  fail(`${DOCKERFILE} declares no COPY sources; the parser is probably wrong.`);
  process.exit(process.exitCode || 0);
}

const contextSet = new Set(context);
const missing = [];
const skipped = [];

for (const source of sources) {
  const normalized = source.replace(/^\.\//, "").replace(/\/$/, "");
  // Build outputs (dist/) do not exist until the build step runs. Absent from
  // disk means "cannot be evaluated", not "excluded" — only a path that exists
  // yet fails to reach the context is a real finding.
  if (!existsSync(path.join(root, normalized))) {
    skipped.push(source);
    continue;
  }
  // A directory source is satisfied by any file beneath it.
  const present =
    contextSet.has(normalized) ||
    context.some((entry) => entry.startsWith(`${normalized}/`));
  if (!present) missing.push(source);
}

if (missing.length > 0) {
  fail(
    `${missing.length} COPY source(s) in ${DOCKERFILE} are excluded from the ` +
      `build context by .gcloudignore, so the deploy will fail inside Cloud Build:`,
  );
  for (const entry of missing) console.error(`  - ${entry}`);
  console.error(
    "\nFix .gcloudignore to re-include them. Note that a negation cannot " +
      "re-include a file whose parent directory is excluded: narrow `dir/` to " +
      "`dir/*` first, then negate the paths you need.",
  );
  process.exit(1);
}

const note = skipped.length > 0 ? `, ${skipped.length} not built yet: ${skipped.join(", ")}` : "";
console.log(
  `deploy-build-context: valid (${sources.length - skipped.length}/${sources.length} ` +
    `COPY sources checked, ${context.length} files in context${note})`,
);
