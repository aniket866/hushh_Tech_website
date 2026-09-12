import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
} from "../../../cloud-run/hushh-tech-cloudsql-attestor/src/constants.js";

export const TARGET = Object.freeze({
  project: "hushh-tech-uat",
  region: "us-central1",
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
  job: "hushh-tech-cloudsql-attestor-uat",
  serviceAccount: "hushh-tech-audit-uat@hushh-tech-uat.iam.gserviceaccount.com",
  network: "default",
  subnet: "default",
  vpcEgress: "private-ranges-only",
});

export const IMAGE_REPOSITORY =
  "us-central1-docker.pkg.dev/hushh-tech-uat/cloud-run-source-deploy/hushh-tech-cloudsql-attestor";

const ATTESTOR_ROOT = resolve("cloud-run/hushh-tech-cloudsql-attestor");
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function buildActivationEnv(imageDigest) {
  if (!IMAGE_DIGEST.test(imageDigest ?? "")) {
    throw new Error("The built attestor image must resolve to an immutable digest.");
  }
  return Object.freeze({
    HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE: "true",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_PROJECT: TARGET.project,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_REGION: TARGET.region,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_INSTANCE: TARGET.instance,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_DATABASE: TARGET.database,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_IAM_DB_USER:
      "hushh-tech-audit-uat@hushh-tech-uat.iam",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_CONTRACT_SHA256:
      EXPECTED_EXECUTION_CONTRACT_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_QUERY_SET_SHA256: EXPECTED_QUERY_SET_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_SOURCE_SHA256: EXPECTED_SOURCE_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_IMAGE_DIGEST: imageDigest,
  });
}

export function parseArguments(argv) {
  const values = new Set(argv);
  const allowed = new Set(["--plan", "--activate-attestation", "--run-attestation"]);
  if ([...values].some((value) => !allowed.has(value))) {
    throw new Error("Only --plan, --activate-attestation, and --run-attestation are supported.");
  }
  if (values.has("--run-attestation") && !values.has("--activate-attestation")) {
    throw new Error("--run-attestation requires --activate-attestation.");
  }
  return Object.freeze({
    activate: values.has("--activate-attestation"),
    run: values.has("--run-attestation"),
  });
}

function gcloudExecutable() {
  return process.platform === "win32" ? "gcloud.cmd" : "gcloud";
}

function gcloud(args, { capture = false } = {}) {
  try {
    const output = execFileSync(gcloudExecutable(), args, {
      cwd: resolve("."),
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    return capture ? output.trim() : "";
  } catch {
    throw new Error("The scoped gcloud operation failed; no UAT resource was accepted.");
  }
}

function sourceCommit() {
  const commit = process.env.COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (COMMIT_SHA.test(commit ?? "")) return commit;
  const output = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!COMMIT_SHA.test(output)) throw new Error("The attestor build requires a full source commit SHA.");
  return output;
}

function assertPackageBoundary() {
  const packagePath = resolve(ATTESTOR_ROOT, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.name !== "@hushh-tech/cloudsql-attestor") {
    throw new Error("The attestor build context is not the reviewed package.");
  }
}

function activationArgs(image, env) {
  const envPairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return [
    "run",
    "jobs",
    "update",
    TARGET.job,
    `--project=${TARGET.project}`,
    `--region=${TARGET.region}`,
    `--image=${image}`,
    `--service-account=${TARGET.serviceAccount}`,
    `--network=${TARGET.network}`,
    `--subnet=${TARGET.subnet}`,
    `--vpc-egress=${TARGET.vpcEgress}`,
    "--tasks=1",
    "--max-retries=0",
    "--task-timeout=25s",
    `--set-env-vars=${envPairs.join(",")}`,
    "--quiet",
  ];
}

export function buildPlan({ commit }) {
  return Object.freeze({
    mode: "READ_ONLY_ATTESTATION",
    apply: false,
    sourceCommit: commit,
    imageRepository: IMAGE_REPOSITORY,
    target: TARGET,
    network: {
      type: "DIRECT_VPC_EGRESS",
      network: TARGET.network,
      subnet: TARGET.subnet,
      egress: TARGET.vpcEgress,
      publicIp: false,
    },
  });
}

export function deployAttestor({ run = false } = {}) {
  assertPackageBoundary();
  const commit = sourceCommit();
  const tag = `${IMAGE_REPOSITORY}:${commit}`;
  gcloud([
    "builds",
    "submit",
    ATTESTOR_ROOT,
    `--project=${TARGET.project}`,
    `--region=${TARGET.region}`,
    `--tag=${tag}`,
    "--quiet",
  ]);
  const digest = gcloud(
    [
      "artifacts",
      "docker",
      "images",
      "describe",
      tag,
      `--project=${TARGET.project}`,
      "--format=value(image_summary.digest)",
    ],
    { capture: true },
  );
  const image = `${IMAGE_REPOSITORY}@${digest}`;
  const env = buildActivationEnv(digest);
  gcloud(activationArgs(image, env));
  if (!run) return Object.freeze({ commit, image, activated: true, execution: null });

  const execution = gcloud(
    [
      "run",
      "jobs",
      "execute",
      TARGET.job,
      `--project=${TARGET.project}`,
      `--region=${TARGET.region}`,
      "--wait",
      "--format=value(metadata.name)",
      "--quiet",
    ],
    { capture: true },
  );
  return Object.freeze({ commit, image, activated: true, execution });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const commit = sourceCommit();
    if (!options.activate) {
      process.stdout.write(`${JSON.stringify(buildPlan({ commit }))}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(deployAttestor({ run: options.run }))}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Attestor deployment failed."}\n`);
    process.exitCode = 1;
  }
}
