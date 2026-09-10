#!/usr/bin/env node
/**
 * Reconciles the Firestore `community_posts` collection with the committed post snapshot.
 *
 * Why this is needed
 * ------------------
 * UAT and prod run with COMMUNITY_CONTENT_BACKEND=gcp. listGcpPosts() in
 * api/community/content-service.js returns the Firestore result whenever the collection is
 * non-empty, and only falls back to STATIC_COMMUNITY_POSTS when it is empty or errors. So the
 * community index shows Firestore, not the repository. Shipping a container with 186 posts in it
 * changes nothing on the index page until Firestore knows about them.
 *
 * Why it is a merge, not a replace
 * --------------------------------
 * Firestore is not a mirror of the repo. It is the write side of the content system: bodies can be
 * edited there, and one document (fund-documents/hushh-alpha-aloha-fund-a-offering-documents) exists
 * only there. So this script:
 *
 *   - inserts documents that do not exist,
 *   - on documents that do exist, PATCHes with an explicit updateMask naming only the fields the
 *     repository is authoritative for, and only where the repo value is non-empty AND differs,
 *   - never deletes a document,
 *   - never writes an empty value over a non-empty one.
 *
 * An updateMask is the whole point of the update half: fields not named in the mask are left
 * exactly as they are, so a body edited in Firestore survives.
 *
 * Document ids
 * ------------
 * The collection's existing convention is `static-` + the slug lowercased with `/` replaced by `-`.
 * Verified against all 135 live documents with zero mismatches, and against all 186 snapshot slugs
 * with zero collisions. Firestore ids cannot contain `/`, so the slug itself is not usable.
 *
 * Usage:
 *   node scripts/community/sync-community-firestore.mjs              # dry run (default)
 *   node scripts/community/sync-community-firestore.mjs --apply
 *   node scripts/community/sync-community-firestore.mjs --apply --project hushh-tech-uat
 *
 * Credentials come from GCP_DEPLOY_SA_KEY_B64. That key reads `hushh-tech-prod` fine — the 403 an
 * earlier version of this comment described is against `hushh-tech`, a different project. What
 * actually stops a production run is that `hushh-tech-prod` has no Firestore `(default)` database
 * at all, so `--project hushh-tech-prod` 404s on every request. Production serves the committed
 * snapshot by design; there is nothing there to sync until a database exists.
 */

import { STATIC_COMMUNITY_POSTS } from "../../api/community/staticPosts.generated.js";
import { normalizePublishedAt } from "../../api/community/postVersions.js";
import { api } from "../deploy/gcp-auth.mjs";

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

const args = parseArgs();
const PROJECT = typeof args.project === "string" ? args.project : "hushh-tech-uat";
const COLLECTION = typeof args.collection === "string" ? args.collection : "community_posts";
const APPLY = Boolean(args.apply);
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}`;

/** The id convention already in the collection. */
export const documentIdFor = (slug) => `static-${slug.toLowerCase().replace(/\//g, "-")}`;

/**
 * Fields the repository is authoritative for on a document that already exists.
 *
 * Deliberately short. `title`, `description`, `category` and the body fields are all editable in
 * Firestore, and overwriting them from a build artifact would silently discard an editor's work.
 * `publishedAt` is here because the collection carries seven day-first dates (`21/07/2025`) that
 * sort as strings and put those posts in the wrong place; `docFamily` / `docVersion` because
 * version identity is defined by the repository's manifest and nowhere else.
 */
const REPO_OWNED_FIELDS = ["publishedAt", "docFamily", "docVersion", "sourceKind", "readingMinutes", "cardCount"];

/**
 * Extra fields the repository owns on a deck, and only on a deck.
 *
 * Every deck document is generated from content/decks/manifest.json and the Gamma export — nobody
 * edits a deck body in Firestore, and doing so would be overwritten by the next export anyway. So
 * for decks the repo is authoritative for the content pointers too, which is how a re-extraction
 * reaches the site. For an article, these stay off the list: overwriting an editor's body from a
 * build artifact is exactly the failure the update mask exists to prevent.
 */
const DECK_OWNED_FIELDS = ["cardsObject", "contentObject", "bodyMarkdown", "description", "title"];

const ownedFieldsFor = (post) =>
  post.sourceKind === "deck" ? [...REPO_OWNED_FIELDS, ...DECK_OWNED_FIELDS] : REPO_OWNED_FIELDS;

const readField = (field) => {
  if (!field) return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number.parseInt(field.integerValue, 10);
  if ("booleanValue" in field) return Boolean(field.booleanValue);
  if ("arrayValue" in field) return (field.arrayValue.values || []).map(readField);
  return undefined;
};

const writeField = (value) => {
  if (Array.isArray(value)) {
    return { arrayValue: value.length ? { values: value.map(writeField) } : {} };
  }
  if (typeof value === "number") return { integerValue: String(Math.trunc(value)) };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value ?? "") };
};

/**
 * The document a post should have when it is created. Mirrors the field set already present on
 * every live document, plus the version fields, so the collection stays homogeneous.
 */
const documentFor = (post) => {
  const fields = {
    slug: post.slug,
    title: post.title || "",
    publishedAt: normalizePublishedAt(post.publishedAt) || post.publishedAt || "",
    description: post.description || "",
    category: post.category || "general",
    accessLevel: post.accessLevel || "Public",
    status: post.status || "published",
    sourceKind: post.sourceKind || "legacy",
    componentName: post.componentName || "",
    bodyMarkdown: post.bodyMarkdown || "",
    contentObject: post.contentObject || "",
    cardsObject: post.cardsObject || "",
    readingMinutes: Number(post.readingMinutes) || 0,
    cardCount: Number(post.cardCount) || 0,
    assetObject: post.assetObject || "",
    assetUrl: post.assetUrl || "",
    pdfUrl: post.pdfUrl || "",
    mediaItems: Array.isArray(post.mediaItems) ? post.mediaItems : [],
    docFamily: post.docFamily || "",
    docVersion: Number.isFinite(Number(post.docVersion)) ? Number(post.docVersion) : 0,
  };
  return { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, writeField(v)])) };
};

const listDocuments = async () => {
  const documents = [];
  let pageToken;
  do {
    const url = new URL(BASE);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await api(url.toString());
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return documents;
};

/**
 * The update half. Returns the fields to change, which is empty for most documents.
 *
 * The three guards, in order: only repo-owned fields, only when the repo actually has a value, and
 * only when it differs. The middle guard is what makes "never clear a non-empty value" true rather
 * than merely intended.
 */
export const planUpdate = (post, existing) => {
  const changes = {};
  for (const field of ownedFieldsFor(post)) {
    let desired = post[field];
    if (field === "publishedAt") desired = normalizePublishedAt(post.publishedAt) || post.publishedAt;
    if (field === "docVersion") desired = Number(post.docVersion) || 0;

    const empty = desired === undefined || desired === null || desired === "" || desired === 0;
    if (empty) continue;

    const current = readField(existing.fields?.[field]);
    if (current === desired) continue;
    changes[field] = desired;
  }
  return changes;
};

const main = async () => {
  const live = await listDocuments();
  const byId = new Map(live.map((document) => [document.name.split("/").pop(), document]));

  const inserts = [];
  const updates = [];
  for (const post of STATIC_COMMUNITY_POSTS) {
    const id = documentIdFor(post.slug);
    const existing = byId.get(id);
    if (!existing) { inserts.push({ id, post }); continue; }
    const changes = planUpdate(post, existing);
    if (Object.keys(changes).length) updates.push({ id, post, existing, changes });
  }

  const snapshotSlugs = new Set(STATIC_COMMUNITY_POSTS.map((post) => documentIdFor(post.slug)));
  const firestoreOnly = live.filter((document) => !snapshotSlugs.has(document.name.split("/").pop()));

  console.log(`project ${PROJECT}, collection ${COLLECTION}`);
  console.log(`  live documents      ${live.length}`);
  console.log(`  snapshot posts      ${STATIC_COMMUNITY_POSTS.length}`);
  console.log(`  to insert           ${inserts.length}`);
  console.log(`  to update           ${updates.length}`);
  console.log(`  Firestore-only      ${firestoreOnly.length} (never touched)`);

  const byAccess = inserts.reduce((counts, { post }) => {
    counts[post.accessLevel || "(none)"] = (counts[post.accessLevel || "(none)"] || 0) + 1;
    return counts;
  }, {});
  console.log(`  inserts by access   ${JSON.stringify(byAccess)}`);

  // Field names and value sizes, not values: a deck body is 50-100 KB and dumping sixteen of them
  // buries the reconciliation this report exists to show.
  const describe = (value) =>
    typeof value === "string" && value.length > 60 ? `${value.length} chars` : JSON.stringify(value);
  for (const { id, changes } of updates) {
    const summary = Object.entries(changes).map(([key, value]) => `${key}=${describe(value)}`);
    console.log(`  update ${id}: ${summary.join(", ")}`);
  }
  if (!APPLY) {
    console.log("\ninserts:");
    for (const { id, post } of inserts) {
      console.log(`  ${id}  [${post.accessLevel}/${post.sourceKind}]  ${post.publishedAt}  ${post.title}`);
    }
    console.log("\ndry run — pass --apply to write");
    return;
  }

  let written = 0;
  for (const { id, post } of inserts) {
    const url = `${BASE}?documentId=${encodeURIComponent(id)}`;
    await api(url, { method: "POST", body: documentFor(post) });
    written += 1;
    if (written % 10 === 0) console.log(`  inserted ${written}/${inserts.length}`);
  }
  console.log(`inserted ${written} document(s)`);

  let patched = 0;
  for (const { id, changes } of updates) {
    const url = new URL(`${BASE}/${encodeURIComponent(id)}`);
    for (const field of Object.keys(changes)) url.searchParams.append("updateMask.fieldPaths", field);
    const fields = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, writeField(v)]));
    await api(url.toString(), { method: "PATCH", body: { fields } });
    patched += 1;
  }
  console.log(`patched ${patched} document(s)`);

  const after = await listDocuments();
  console.log(`collection now holds ${after.length} documents`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
