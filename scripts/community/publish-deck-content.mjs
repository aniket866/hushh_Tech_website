#!/usr/bin/env node
/**
 * Publishes each deck's reading content to the community content bucket.
 *
 * Two files per deck, both under the deck's own access prefix so isNdaAsset() in
 * api/community/content-service.js governs them:
 *
 *   <prefix>/cards.json   the structured cards the deck reader renders
 *   <prefix>/index.md     the same content as markdown, which the API streams as bodyMarkdown
 *                         for a gated deck and which is the source for the crawler-visible body
 *
 * Public decks also carry their markdown inline in the committed snapshot; the copy here keeps the
 * two prefixes symmetrical so nothing has to special-case access level at read time.
 *
 * Usage:
 *   node scripts/community/publish-deck-content.mjs --bucket hushh-tech-community-content-uat
 *   node scripts/community/publish-deck-content.mjs --dry-run
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(root, "content/decks/manifest.json");

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith("--")) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : (i += 1, next);
}

const BUCKET = typeof args.bucket === "string" ? args.bucket : "hushh-tech-community-content-uat";
const DRY_RUN = Boolean(args["dry-run"]);

const prefixFor = (deck) =>
  deck.accessLevel === "NDA" ? `gated/decks/${deck.assetName}` : `decks/${deck.assetName}`;

const localPaths = (deck) => ({
  cards: join(root, deck.accessLevel === "NDA" ? "content/decks/cards-gated" : "content/decks/cards", `${deck.assetName}.json`),
  markdown: join(root, deck.accessLevel === "NDA" ? "content/decks/text-gated" : "content/decks/text", `${deck.assetName}.md`),
});

const storage = async () => {
  const encoded = process.env.GCP_DEPLOY_SA_KEY_B64;
  if (!encoded) throw new Error("GCP_DEPLOY_SA_KEY_B64 is not set");
  const credentials = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const { Storage } = await import("@google-cloud/storage");
  return new Storage({ credentials, projectId: credentials.project_id });
};

const main = async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const only = typeof args.deck === "string" ? args.deck : "";
  const decks = manifest.decks.filter((deck) => !only || deck.slug === only);
  const bucket = DRY_RUN ? null : (await storage()).bucket(BUCKET);

  let written = 0;
  const missing = [];

  for (const deck of decks) {
    const prefix = prefixFor(deck);
    const paths = localPaths(deck);

    for (const [name, path, contentType] of [
      ["cards.json", paths.cards, "application/json; charset=utf-8"],
      ["index.md", paths.markdown, "text/markdown; charset=utf-8"],
    ]) {
      if (!existsSync(path)) {
        missing.push(`${deck.slug}: ${name}`);
        continue;
      }
      const body = readFileSync(path);
      const objectName = `${prefix}/${name}`;
      if (DRY_RUN) {
        console.log(`  would write ${objectName}  ${(body.length / 1024).toFixed(0)} KB`);
      } else {
        await bucket.file(objectName).save(body, {
          resumable: false,
          contentType,
          // The API sets the response Cache-Control from the prefix, so a gated object is served
          // private, no-store whatever is stored here. This only governs the bucket's own copy.
          metadata: { cacheControl: deck.accessLevel === "NDA" ? "no-store" : "public, max-age=3600" },
        });
        console.log(`  ${objectName.padEnd(62)} ${(body.length / 1024).toFixed(0)} KB`);
      }
      written += 1;
    }
  }

  console.log(`\n${DRY_RUN ? "would publish" : "published"} ${written} file(s) across ${decks.length} deck(s)`);
  if (missing.length) {
    console.log(`\nmissing locally — run convert-gamma-export.mjs first:`);
    for (const entry of missing) console.log(`  ${entry}`);
    process.exitCode = 1;
  }
};

main().catch((error) => { console.error(error); process.exit(1); });
