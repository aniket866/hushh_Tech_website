#!/usr/bin/env node
/**
 * Builds and deploys this repository to the UAT Cloud Run service without gcloud or GitHub Actions.
 *
 * Why this exists
 * ---------------
 * The normal path is .github/workflows/deploy-uat.yml, which only ever ships a green `main`. That
 * is the right gate for a release, and the wrong one for validating a branch on UAT. This script
 * is the branch path: Cloud Build builds the image from a source archive, and Cloud Run Admin v2
 * takes the new image through a read-modify-write PATCH.
 *
 * Why not `cloudbuild-uat.yaml`
 * -----------------------------
 * That file deploys with `--set-env-vars` / `--set-secrets`, which are replace-not-merge. The live
 * revision carries 30 plain env vars and 18 secret-backed ones — Cloud SQL wiring, the Firebase
 * project, the Research client, GA4 and Search Console. That file names five and eleven. Running
 * it would silently drop two thirds of the service's configuration.
 *
 * So the deploy here reads the current service, changes exactly three things — the container image,
 * DEPLOY_COMMIT_SHA, and the revision labels — and writes it back. Everything else, including every
 * secret binding, VPC setting and Cloud SQL mount, is carried through byte for byte.
 *
 * Secrets
 * -------
 * The two real build-time secrets (the Firebase web API key and app id) travel Secret Manager →
 * Cloud Build `availableSecrets` → the docker build arg. They are never read into this process,
 * never written to disk, and `docker build` gets them through the step's environment rather than
 * through an argv the build log would echo.
 *
 * Usage:
 *   node scripts/deploy/uat-deploy.mjs                 # build and deploy HEAD
 *   node scripts/deploy/uat-deploy.mjs --dry-run       # print the build and the service patch
 *   node scripts/deploy/uat-deploy.mjs --build-only    # build the image, do not touch Cloud Run
 *   node scripts/deploy/uat-deploy.mjs --image <ref>   # skip the build, deploy an existing image
 *   node scripts/deploy/uat-deploy.mjs --rollback <image>   # PATCH an earlier image back
 *   node scripts/deploy/uat-deploy.mjs --allow-stale   # ship a branch that is behind main anyway
 *
 * Local credentials may come from GCP_DEPLOY_SA_KEY_B64. Cloud Build uses ADC from the trigger
 * service account, so no long-lived key is placed in the trigger or the build workspace. The UAT
 * project is still fixed below; this script cannot reach production even if someone edits a local
 * environment variable.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { api, serviceAccount, sleep } from "./gcp-auth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PROJECT = "hushh-tech-uat";
const REGION = "us-central1";
const SERVICE = "hushh-tech-website";
const SOURCE_BUCKET = "hushh-tech-uat_cloudbuild";
const IMAGE_REPO = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE}`;
// The legacy <project-number>@cloudbuild SA no longer exists in this project; recent successful
// builds all ran as the compute default. Naming it explicitly keeps the behaviour pinned.
const BUILD_SA = process.env.GCP_BUILD_SA ||
  `projects/${PROJECT}/serviceAccounts/175298245599-compute@developer.gserviceaccount.com`;

/**
 * Exactly the paths Dockerfile.gcp copies. A whole-tree archive is 188 MB and most of it — the
 * migration ledgers, cloud-run registries, tests, mobile shells — never enters the image. Scoping
 * the archive to the build inputs also makes the build context something a reviewer can read.
 */
const SOURCE_PATHS = [
  "package.json",
  "package-lock.json",
  "package-server.json",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "postcss.config.js",
  "tailwind.config.js",
  ".dockerignore",
  "Dockerfile.gcp",
  "server.js",
  "src",
  "public",
  "files",
  "api",
  "content",
  "scripts/generate-sitemap.js",
  "scripts/generate-robots.js",
  "scripts/generate-llms-txt.mjs",
  "scripts/community",
  "scripts/ci/check-no-hybrid-runtime.mjs",
  "scripts/ci/no-hybrid-runtime-policy.json",
];

/**
 * Build args. Only the two Firebase web credentials are secrets; the rest are public configuration
 * and are pinned here to the same values .github/workflows/deploy-uat.yml uses, so a Cloud Build
 * image and an Actions image describe the same environment.
 */
const BUILD_ARGS = {
  VITE_FIREBASE_AUTH_DOMAIN: "uat.hushhtech.com",
  VITE_FIREBASE_PROJECT_ID: "hushh-tech-uat",
  VITE_GCP_API_BASE_URL: "https://uat.hushhtech.com",
  VITE_GCP_AUTH_REDIRECT_URL: "https://uat.hushhtech.com/auth/callback",
  VITE_PLAID_REDIRECT_URI: "https://uat.hushhtech.com/onboarding/financial-link",
  VITE_ALLOW_INSECURE_BROWSER_LLM: "false",
  VITE_KYC_ENV: "staging",
  VITE_KYC_DEMO_MODE: "true",
};

const SECRET_BUILD_ARGS = {
  VITE_FIREBASE_API_KEY: `projects/${PROJECT}/secrets/hushh-tech-firebase-web-api-key/versions/latest`,
  VITE_FIREBASE_APP_ID: `projects/${PROJECT}/secrets/hushh-tech-firebase-web-app-id/versions/latest`,
};

const parseArgs = () => {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
};

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const fail = (message) => { console.error(`uat-deploy: ${message}`); process.exit(1); };

/** The branch a deploy must already contain. Overridable for a release branch, not for a bypass. */
const BASE_BRANCH = process.env.UAT_DEPLOY_BASE_BRANCH || "main";

/**
 * Refuse to ship a tree that does not already contain `origin/main`.
 *
 * This is the deploy-side half of the branch-freshness gate, and it is here because CI cannot
 * cover it. CI runs on a pull request; this script runs on whatever is checked out, which is how
 * a branch that was fresh when it was validated gets shipped hours later over work that landed in
 * between. The result is not a merge conflict anyone sees — it is a revision serving a copy of
 * files as they were before the fix, with no diff and no failing test to say so.
 *
 * Three deliberate exemptions:
 *
 *   - `--rollback`, never checked. A rollback ships an older image on purpose, usually during an
 *     incident. A freshness gate that argued with a rollback would be a gate that gets deleted.
 *   - No Git metadata. Cloud Build's own source checkouts carry the trigger commit but no history,
 *     and there the `freshness` step in cloudbuild.ci.yaml is what proves the same property.
 *   - `--allow-stale`, which says so out loud in the log. The escape hatch exists so the answer to
 *     an urgent stale deploy is a documented flag rather than someone deleting this function.
 *
 * `--dry-run` reports but does not block, so the plan stays inspectable from any checkout.
 */
const assertBaseFreshness = (sha, args) => {
  if (args["allow-stale"]) {
    console.warn(`uat-deploy: --allow-stale — shipping ${sha.slice(0, 8)} without the freshness check.`);
    return;
  }

  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
  } catch {
    console.log("uat-deploy: no Git metadata here; freshness is the build trigger's `freshness` step.");
    return;
  }

  try {
    execFileSync("sh", [join(root, "scripts/git/check-main-sync.sh")], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        MAIN_SYNC_MODE: args["dry-run"] ? "warn" : "block",
        MAIN_SYNC_HEAD: sha,
        MAIN_SYNC_BRANCH: BASE_BRANCH,
        MAIN_SYNC_LABEL: `${sha.slice(0, 8)} (deploy candidate)`,
      },
    });
  } catch {
    fail(
      `refusing to deploy ${sha.slice(0, 8)} — it does not contain origin/${BASE_BRANCH}.\n` +
        `  git fetch origin ${BASE_BRANCH} && git merge origin/${BASE_BRANCH}\n` +
        "  bash scripts/ci/orchestrate.sh fidelity   # prove the merge kept what the base landed\n" +
        "Deploy anyway only with --allow-stale, and only when you mean to overwrite that work.",
    );
  }
};

// --------------------------------------------------------------------------------------------
// Source archive
// --------------------------------------------------------------------------------------------

/**
 * `git archive` rather than a tar of the working tree, so a local image provably contains the
 * commit that DEPLOY_COMMIT_SHA names. Cloud Build's source trigger intentionally omits `.git`;
 * there the trigger's immutable COMMIT_SHA is required and the checked-out source tree is archived
 * directly. This keeps the same helper usable locally and in the GCP-only deploy lane.
 */
const buildSourceArchive = async (sha, directory) => {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    fail("source commit must be a hexadecimal Git SHA");
  }

  // gzip -1: the archive is mostly already-compressed images, so a higher level costs seconds and
  // saves almost nothing.
  const archivePath = join(directory, "source.tgz");
  let hasGit = false;
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
    hasGit = true;
  } catch {
    // Cloud Build source checkouts contain the trigger commit but no Git metadata.
  }

  if (hasGit) {
    const dirty = git("status", "--porcelain");
    if (dirty) fail(`working tree is dirty; commit first so the image matches ${sha.slice(0, 8)}\n${dirty}`);
    // Keep the commit SHA and paths as argv values. Shell interpolation here would let a
    // malformed --sha turn the deploy helper into an arbitrary command runner.
    const archive = execFileSync("git", ["archive", "--format=tar", sha, "--", ...SOURCE_PATHS], {
      cwd: root,
      maxBuffer: 512 * 1024 * 1024,
    });
    const compressed = gzipSync(archive, { level: 1 });
    await writeFile(archivePath, compressed);
  } else {
    const triggerSha = process.env.COMMIT_SHA;
    if (!triggerSha || triggerSha !== sha) {
      fail("Cloud Build source has no Git metadata; require --sha to equal the trigger COMMIT_SHA");
    }
    execFileSync("tar", ["-czf", archivePath, "-C", root, ...SOURCE_PATHS]);
  }
  const { size } = await stat(archivePath);
  if (size < 1024) fail("source archive is empty");
  return { archivePath, size };
};

const uploadSource = async (archivePath, objectName) => {
  const credentials = serviceAccount();
  if (credentials) {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: PROJECT, credentials });
    const [file] = await storage
      .bucket(SOURCE_BUCKET)
      .upload(archivePath, { destination: objectName, resumable: true, contentType: "application/gzip" });
    return { bucket: SOURCE_BUCKET, object: objectName, generation: file.metadata.generation };
  }
  execFileSync("gcloud", [
    "storage", "cp", archivePath, `gs://${SOURCE_BUCKET}/${objectName}`,
    `--project=${PROJECT}`,
  ], { cwd: root, stdio: "inherit", shell: true });
  return { bucket: SOURCE_BUCKET, object: objectName };
};

// --------------------------------------------------------------------------------------------
// Cloud Build
// --------------------------------------------------------------------------------------------

/**
 * The docker step runs through bash so the secret build args can be read from the step's
 * environment. `$$` is Cloud Build's escape for a literal `$`; a bare `$VAR` would be parsed as a
 * substitution and rejected. Values reach docker through the environment, so neither key is
 * echoed into the build log by the command line itself.
 */
const buildRequest = (source, tag, sha) => {
  const image = `${IMAGE_REPO}:${tag}`;
  const publicArgs = Object.entries(BUILD_ARGS)
    .map(([name, value]) => `    --build-arg ${name}=${JSON.stringify(value)} \\`)
    .join("\n");
  const secretArgs = Object.keys(SECRET_BUILD_ARGS)
    .map((name) => `    --build-arg ${name}="$$${name}" \\`)
    .join("\n");

  return {
    source: { storageSource: { bucket: source.bucket, object: source.object, generation: source.generation } },
    serviceAccount: BUILD_SA,
    options: {
      logging: "CLOUD_LOGGING_ONLY",
      machineType: "E2_HIGHCPU_8",
    },
    availableSecrets: {
      secretManager: Object.entries(SECRET_BUILD_ARGS).map(([env, versionName]) => ({ versionName, env })),
    },
    steps: [
      {
        name: "gcr.io/cloud-builders/docker",
        entrypoint: "bash",
        secretEnv: Object.keys(SECRET_BUILD_ARGS),
        args: [
          "-c",
          [
            "set -euo pipefail",
            `docker build \\`,
            `    -f Dockerfile.gcp \\`,
            publicArgs,
            secretArgs,
            `    -t ${image} \\`,
            `    -t ${IMAGE_REPO}:uat-latest \\`,
            "    .",
          ].join("\n"),
        ],
      },
    ],
    // Cloud Build pushes everything named here after the steps finish, and reports each digest
    // back in build.results.images — which is where the immutable reference the deploy pins comes
    // from. Explicit push steps would duplicate that work and report nothing.
    images: [image, `${IMAGE_REPO}:uat-latest`],
    tags: ["uat", "branch-deploy", `sha-${sha.slice(0, 8)}`],
    timeout: "2400s",
  };
};

const waitForBuild = async (buildId) => {
  const terminal = new Set(["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);
  let lastStatus = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const build = await api(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/builds/${buildId}`);
    if (build.status !== lastStatus) {
      lastStatus = build.status;
      console.log(`  build ${buildId.slice(0, 8)}: ${build.status}`);
    }
    if (terminal.has(build.status)) return build;
    await sleep(10_000);
  }
  throw new Error(`build ${buildId} did not finish within 50 minutes`);
};

/** Cloud Build logs land in Cloud Logging; pull the tail so a failure explains itself here. */
const buildLogTail = async (buildId, lines = 60) => {
  try {
    const response = await api("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      body: {
        resourceNames: [`projects/${PROJECT}`],
        filter: `logName="projects/${PROJECT}/logs/cloudbuild" AND resource.labels.build_id="${buildId}"`,
        orderBy: "timestamp desc",
        pageSize: lines,
      },
    });
    return (response.entries || []).reverse().map((entry) => entry.textPayload ?? "").filter(Boolean);
  } catch (error) {
    return [`(could not read build logs: ${error.message.split("\n")[0]})`];
  }
};

// --------------------------------------------------------------------------------------------
// Cloud Run
// --------------------------------------------------------------------------------------------

const serviceUrl = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`;

const getService = () => api(serviceUrl);

/**
 * The whole point of this function is what it does NOT change. It takes the live service and
 * returns the same object with three edits, so every env var, secret binding, VPC connector,
 * Cloud SQL mount, scaling bound and traffic target survives the deploy untouched.
 */
/** UTC yyyymmddhhmm — sorts chronologically as a string, and is unique per minute. */
const revisionStamp = (now = new Date()) => now.toISOString().replace(/[-:T]/g, "").slice(0, 12);

export const planPatch = (service, { image, sha }) => {
  const next = structuredClone(service);
  const container = next.template.containers[0];
  container.image = image;

  const deploySha = container.env.find((entry) => entry.name === "DEPLOY_COMMIT_SHA");
  if (deploySha) deploySha.value = sha;
  else container.env.push({ name: "DEPLOY_COMMIT_SHA", value: sha });

  // Revision names are unique, so the live one cannot be carried forward. Letting Cloud Run
  // generate one is worse than it sounds: its counter is not gcloud's, so the first deploy through
  // this path produced `hushh-tech-website-00211-klc` while `…-00248-qic` was the revision it
  // replaced. Sorted by name in the console, the newest revision then looks like the oldest —
  // exactly the wrong thing to be true when someone is picking a rollback target under pressure.
  //
  // So name it explicitly, timestamp first so lexical order is chronological order, then the
  // commit. Re-deploying the same commit gets a new name rather than a conflict.
  next.template.revision = `${SERVICE}-${revisionStamp()}-${sha.slice(0, 8)}`;

  next.template.labels = {
    ...(next.template.labels || {}),
    "deploy-env": "uat",
    "deploy-commit": sha,
    "deploy-tag": `uat-${sha.slice(0, 8)}`,
  };

  // Server-set fields; sending them back is at best noise and at worst a 400.
  for (const field of [
    "uid", "generation", "createTime", "updateTime", "creator", "lastModifier",
    "latestReadyRevision", "latestCreatedRevision", "observedGeneration", "terminalCondition",
    "conditions", "reconciling", "etag", "urls", "uri", "satisfiesPzs",
  ]) delete next[field];

  return next;
};

const patchService = async (body) => {
  // updateMask is deliberately absent: this is a full read-modify-write, so the body IS the
  // intended end state and a partial mask could not express "and keep everything else".
  const operation = await api(serviceUrl, { method: "PATCH", body });
  return operation;
};

const waitForOperation = async (operationName) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operation = await api(`https://run.googleapis.com/v2/${operationName}`);
    if (operation.done) {
      if (operation.error) throw new Error(`Cloud Run operation failed: ${JSON.stringify(operation.error)}`);
      return operation.response;
    }
    await sleep(5_000);
  }
  throw new Error(`Cloud Run operation ${operationName} did not finish within 10 minutes`);
};

// --------------------------------------------------------------------------------------------

const summariseService = (service) => {
  const container = service.template.containers[0];
  return {
    image: container.image,
    plainEnv: container.env.filter((entry) => !entry.valueSource).length,
    secretEnv: container.env.filter((entry) => entry.valueSource).length,
    serviceAccount: service.template.serviceAccount,
    latestReady: (service.latestReadyRevision || "").split("/").pop(),
  };
};

const main = async () => {
  const args = parseArgs();
  const sha = args.sha || git("rev-parse", "HEAD");
  const shortSha = sha.slice(0, 8);

  if (!args.rollback) assertBaseFreshness(sha, args);

  const before = await getService();
  console.log("current UAT service:", JSON.stringify(summariseService(before), null, 2));

  if (args.rollback) {
    const body = planPatch(before, { image: args.rollback, sha: args.sha || sha });
    if (args["dry-run"]) { console.log(JSON.stringify(body.template.containers[0], null, 2)); return; }
    const operation = await patchService(body);
    await waitForOperation(operation.name);
    console.log(`rolled back to ${args.rollback}`);
    return;
  }

  let image = typeof args.image === "string" ? args.image : null;

  if (!image) {
    const directory = await mkdtemp(join(tmpdir(), "uat-source-"));
    try {
      const { archivePath, size } = await buildSourceArchive(sha, directory);
      console.log(`source archive: ${(size / 1048576).toFixed(1)} MB from ${shortSha}`);

      const objectName = `source/uat-${shortSha}-${Date.now()}.tgz`;
      const request = args["dry-run"]
        ? buildRequest({ bucket: SOURCE_BUCKET, object: objectName }, shortSha, sha)
        : buildRequest(await uploadSource(archivePath, objectName), shortSha, sha);

      if (args["dry-run"]) {
        console.log(JSON.stringify(request, null, 2));
        console.log("\n--- service patch ---");
        console.log(JSON.stringify(planPatch(before, { image: `${IMAGE_REPO}:${shortSha}`, sha }).template, null, 2));
        return;
      }

      console.log(`uploaded gs://${SOURCE_BUCKET}/${objectName}`);
      const operation = await api(`https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/builds`, {
        method: "POST",
        body: request,
      });
      const buildId = operation.metadata.build.id;
      console.log(`build: https://console.cloud.google.com/cloud-build/builds/${buildId}?project=${PROJECT}`);

      const build = await waitForBuild(buildId);
      if (build.status !== "SUCCESS") {
        for (const line of await buildLogTail(buildId)) console.error(`  | ${line}`);
        fail(`build finished ${build.status}`);
      }

      const built = (build.results?.images || []).find((entry) => entry.name?.endsWith(`:${shortSha}`));
      if (!built?.digest) fail("build succeeded but reported no image digest");
      image = `${IMAGE_REPO}@${built.digest}`;
      console.log(`image: ${image}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  if (args["build-only"]) { console.log("--build-only: stopping before the Cloud Run patch"); return; }

  // Rollback material, written before the patch so it exists even if the process dies mid-deploy.
  const rollbackPath = join(tmpdir(), `uat-rollback-${shortSha}.json`);
  await writeFile(
    rollbackPath,
    JSON.stringify({ image: before.template.containers[0].image, revision: summariseService(before).latestReady }, null, 2),
  );
  console.log(`rollback state: ${rollbackPath}`);

  const operation = await patchService(planPatch(before, { image, sha }));
  console.log("patching Cloud Run…");
  const after = await waitForOperation(operation.name);

  const summary = summariseService(after);
  console.log("deployed:", JSON.stringify(summary, null, 2));

  const beforeSummary = summariseService(before);
  if (summary.plainEnv !== beforeSummary.plainEnv || summary.secretEnv !== beforeSummary.secretEnv) {
    fail(
      `env drift: ${beforeSummary.plainEnv}+${beforeSummary.secretEnv} → ${summary.plainEnv}+${summary.secretEnv}. ` +
        `Roll back with --rollback ${beforeSummary.image}`,
    );
  }
  console.log(`configuration preserved: ${summary.plainEnv} env vars + ${summary.secretEnv} secret bindings`);

  /*
   * Prune obsolete images now that the deploy has landed.
   *
   * Here rather than on a schedule because this is the only moment the set of images that matter
   * has just been settled: the new one is serving, the old ones are whatever the surviving
   * revisions still pin. It deletes only images that no revision references, carry no tag, are
   * past the keep window and are not among the newest few — a Cloud Run revision is pinned to a
   * digest, so a careless pruner is a silent rollback floor.
   *
   * Never fails the deploy. The image is already live; a registry that did not get tidied is a
   * cost problem for tomorrow, not a reason to report a successful ship as broken.
   */
  console.log("\npruning obsolete images…");
  try {
    const { pruneAfterDeploy } = await import("../gcp/registry/prune-after-deploy.mjs");
    await pruneAfterDeploy({ apply: !process.argv.includes("--no-prune") });
  } catch (error) {
    console.warn(`  prune skipped: ${error?.message ?? error}`);
  }
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
