#!/usr/bin/env node
/**
 * Delete images the deploy has made obsolete, without ever deleting one something still needs.
 *
 * Every deploy pushes a new image and nothing has ever removed one, so the repository grows
 * monotonically and the storage line grows with it. Running this at the end of a deploy is the
 * natural place: the set of images that matter has just changed, and it is the only moment we know
 * for certain which one is current.
 *
 * The hazard this is built around is that a Cloud Run revision is pinned to an image DIGEST. Delete
 * the image and that revision can never start again, so a pruner is really a rollback floor. That
 * failure is invisible until the day someone needs to roll back, which is the worst day to find it.
 *
 * So an image is only ever a candidate when ALL of these hold:
 *
 *   1. No revision on the service references it. Not just the serving one — every revision that
 *      still exists is a rollback target someone may reach for.
 *   2. It carries no tag. A tagged image is named by something, and we do not know what.
 *   3. It is older than the keep window.
 *   4. It is not among the most recent N, whatever their age. A quiet fortnight must not leave the
 *      repository one deep.
 *
 * Dry run unless `--apply` is passed, and it prints what it would delete either way.
 *
 * Usage:
 *   node scripts/gcp/registry/prune-after-deploy.mjs
 *   node scripts/gcp/registry/prune-after-deploy.mjs --apply
 */

import { api } from "../../deploy/gcp-auth.mjs";

const PROJECT = "hushh-tech-uat";
const REGION = "us-central1";
const REPOSITORY = "cloud-run-source-deploy";
const PACKAGE = "hushh-tech-website";
const SERVICE = "hushh-tech-website";

/** Nothing younger than this is touched, tagged or not. A deploy needs room to be rolled back. */
export const KEEP_DAYS = 30;

/** And this many most-recent images survive regardless of age. */
export const KEEP_RECENT = 10;


/**
 * Which images may be deleted.
 *
 * Pure, because this is the decision worth testing and the API calls around it are not. `inUse` is
 * the set of digests any surviving revision references.
 */
export const selectPrunable = (versions, inUse, { now = Date.now(), keepDays = KEEP_DAYS, keepRecent = KEEP_RECENT } = {}) => {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const sorted = [...versions].sort(
    (a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime(),
  );
  const recent = new Set(sorted.slice(0, keepRecent).map((v) => v.name));

  return sorted.filter((version) => {
    const digest = version.name.split("/").pop();
    if (inUse.has(digest)) return false;
    if ((version.tags || []).length > 0) return false;
    if (recent.has(version.name)) return false;
    return new Date(version.createTime).getTime() < cutoff;
  });
};

/**
 * Run the prune. Exported so the deploy calls it in-process rather than shelling out, which keeps
 * its failure a caught exception instead of an exit code nobody reads.
 */
export const pruneAfterDeploy = async ({ apply = false } = {}) => {
  const base = `https://artifactregistry.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/repositories/${REPOSITORY}`;

  // Every revision, not just the serving one: each is somebody's rollback target.
  const revisions = await api(
    `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}/revisions?pageSize=200`,
  );
  const inUse = new Set(
    (revisions.revisions || [])
      .map((r) => r.containers?.[0]?.image ?? "")
      .map((image) => image.split("@").pop())
      .filter((digest) => digest.startsWith("sha256:")),
  );

  let versions = [];
  let pageToken = "";
  do {
    const page = await api(
      `${base}/packages/${PACKAGE}/versions?pageSize=200&view=FULL${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    versions = versions.concat(page.versions || []);
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  const prunable = selectPrunable(versions, inUse);

  console.log(`images in repository : ${versions.length}`);
  console.log(`pinned by a revision : ${inUse.size}`);
  console.log(`keep window          : ${KEEP_DAYS} days, plus the ${KEEP_RECENT} newest`);
  console.log(`${apply ? "deleting" : "would delete"}     : ${prunable.length}\n`);

  for (const version of prunable) {
    const digest = version.name.split("/").pop();
    const age = Math.round((Date.now() - new Date(version.createTime).getTime()) / 86_400_000);
    console.log(`  ${digest.slice(0, 19)}…  ${age}d old`);
    if (apply) await api(`https://artifactregistry.googleapis.com/v1/${version.name}`, { method: "DELETE" });
  }

  if (!prunable.length) console.log("  nothing is both unreferenced, untagged and past the window");
  if (!apply && prunable.length) console.log("\nre-run with --apply to delete");
  return prunable.length;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await pruneAfterDeploy({ apply: process.argv.includes("--apply") });
}
