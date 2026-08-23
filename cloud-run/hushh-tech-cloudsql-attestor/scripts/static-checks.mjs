import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { validateRuntimeContracts } from "../src/contracts.js";
import { loadAndValidateQueryContract } from "../src/query-contract.js";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const runner = readFileSync(resolve(root, "src/runner.js"), "utf8");
const cli = readFileSync(resolve(root, "src/cli.js"), "utf8");

function fail(message) {
  throw new Error(message);
}

if (
  !dockerfile.startsWith(
    "FROM --platform=linux/amd64 node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3\n",
  ) ||
  !dockerfile.includes("USER 1000:1000") ||
  !dockerfile.includes("npm ci --omit=dev --ignore-scripts") ||
  !dockerfile.includes('ENTRYPOINT ["node", "src/supervisor.js"]')
) {
  fail("Docker runtime must remain literal linux/amd64, digest-pinned, non-root, and lockfile-only.");
}

if (
  packageJson.engines.node !== "22.22.0" ||
  packageJson.dependencies["@google-cloud/cloud-sql-connector"] !== "1.11.3" ||
  packageJson.dependencies.pg !== "8.16.3" ||
  packageLock.lockfileVersion !== 3 ||
  packageLock.packages[""].dependencies["@google-cloud/cloud-sql-connector"] !== "1.11.3" ||
  packageLock.packages[""].dependencies.pg !== "8.16.3"
) {
  fail("Node and runtime dependencies must remain exactly pinned in package and lock files.");
}

if (
  !runner.includes("password: () => undefined") ||
  /\bpassword\s*:/i.test(runner.replace("password: () => undefined", "")) ||
  /console\.(?:log|error|warn)|process\.stderr/.test(`${runner}\n${cli}`) ||
  /\b(?:setInterval|retry|backoff)\b/i.test(runner)
) {
  fail("Runner drifted into password, raw logging, or retry behavior.");
}

for (const directory of ["src", "scripts", "test"]) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      execFileSync(process.execPath, ["--check", resolve(root, directory, entry.name)], {
        stdio: "pipe",
      });
    }
  }
}

loadAndValidateQueryContract();
validateRuntimeContracts();
process.stdout.write('{"valid":true,"networkCalls":0,"liveProof":false}\n');
