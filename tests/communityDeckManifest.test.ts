import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATIC_COMMUNITY_POSTS } from "../api/community/staticPosts.generated.js";

const repoRoot = join(__dirname, "..");
const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

type Deck = {
  gammaId: string;
  slug: string;
  assetName: string;
  title: string;
  publishedAt: string;
  category: string;
  accessLevel: "Public" | "NDA";
  docFamily: string;
  docVersion: number;
  pageCount?: number;
  description?: string;
};

const manifest = JSON.parse(read("content/decks/manifest.json")) as { decks: Deck[] };
const decks = manifest.decks;

// Mirrors isNdaAsset() in api/community/content-service.js. Anything outside these prefixes is
// served publicly with an hour of cache.
const NDA_PREFIX = /^(gated|nda|private|sensitive)\//i;

const snapshot = STATIC_COMMUNITY_POSTS as Array<{
  slug: string;
  accessLevel: string;
  sourceKind?: string;
  bodyMarkdown?: string;
  publishedAt: string;
}>;

describe("curated deck manifest", () => {
  it("has decks to check", () => {
    expect(decks.length).toBeGreaterThan(0);
  });

  it("gives every deck the fields the generators depend on", () => {
    for (const deck of decks) {
      // Either handle read_gamma accepts: the API id (g_…) or the doc token that appears in a
      // gamma.app/docs URL. Ten decks are recorded by the token the site was already embedding,
      // which is the provenance that can actually be checked against the old markup.
      expect(deck.gammaId, `${deck.slug} gammaId`).toMatch(/^(g_[a-z0-9]+|[a-z0-9]{15})$/);
      expect(deck.slug, "slug").toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(deck.assetName, `${deck.slug} assetName`).toMatch(/^[a-z0-9-]+$/);
      expect(deck.publishedAt, `${deck.slug} publishedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["Public", "NDA"], `${deck.slug} accessLevel`).toContain(deck.accessLevel);
      expect(deck.docFamily, `${deck.slug} docFamily`).toBeTruthy();
    }
  });

  it("keeps slugs, asset names and doc families unique", () => {
    expect(new Set(decks.map((d) => d.slug)).size).toBe(decks.length);
    expect(new Set(decks.map((d) => d.assetName)).size).toBe(decks.length);
    expect(new Set(decks.map((d) => d.docFamily)).size).toBe(decks.length);
  });
});

/**
 * The gate that matters. Nine of these decks carry fund allocations, AUM figures and price
 * targets. If one reaches the public list, or its page images land outside a gated GCS prefix,
 * that material is published — and the plain `decks/` prefix is cacheable for an hour, so it
 * would stay published after the mistake was noticed.
 */
describe("NDA deck gating", () => {
  const ndaDecks = decks.filter((deck) => deck.accessLevel === "NDA");
  const publicDecks = decks.filter((deck) => deck.accessLevel === "Public");

  it("has NDA decks to protect", () => {
    expect(ndaDecks.length).toBeGreaterThan(0);
  });

  it("marks every NDA deck NDA in the generated API snapshot", () => {
    for (const deck of ndaDecks) {
      const post = snapshot.find((entry) => entry.slug === deck.slug);
      expect(post, `${deck.slug} missing from the snapshot`).toBeTruthy();
      expect(post?.accessLevel, `${deck.slug} accessLevel`).toBe("NDA");
    }
  });

  it("routes NDA deck assets through a gated prefix and public ones through decks/", () => {
    for (const deck of ndaDecks) {
      const wrapper = read(`src/content/posts/general/decks/${deck.assetName}.tsx`);
      const match = /imageBaseSrc="\/api\/community\/assets\/(.+?)\/pages"/.exec(wrapper);
      expect(match, `${deck.slug} has no imageBaseSrc`).toBeTruthy();
      expect(match![1], `${deck.slug} asset prefix`).toMatch(NDA_PREFIX);
    }
    for (const deck of publicDecks) {
      const wrapper = read(`src/content/posts/general/decks/${deck.assetName}.tsx`);
      const match = /imageBaseSrc="\/api\/community\/assets\/(.+?)\/pages"/.exec(wrapper);
      expect(match![1], `${deck.slug} asset prefix`).not.toMatch(NDA_PREFIX);
    }
  });

  it("never serves NDA deck text to the public list", () => {
    // bodyMarkdown carries the full deck prose; the access filter is what keeps it private.
    const publicSlugs = new Set(
      snapshot.filter((entry) => entry.accessLevel === "Public").map((entry) => entry.slug),
    );
    const leaked = ndaDecks.filter((deck) => publicSlugs.has(deck.slug)).map((deck) => deck.slug);
    expect(leaked).toEqual([]);
  });
});

describe("generated deck posts", () => {
  it("has a wrapper per deck whose page count matches the manifest", () => {
    for (const deck of decks) {
      const path = `src/content/posts/general/decks/${deck.assetName}.tsx`;
      expect(existsSync(join(repoRoot, path)), `${path} missing`).toBe(true);
      const wrapper = read(path);
      const pageCount = /imagePageCount=\{(\d+)\}/.exec(wrapper)?.[1];
      expect(Number(pageCount), `${deck.slug} imagePageCount`).toBe(deck.pageCount);
    }
  });

  it("renders decks from self-hosted pages, never a gamma.app iframe", () => {
    // An iframe would put the deck behind a third party and contribute no indexable text.
    for (const deck of decks) {
      const wrapper = read(`src/content/posts/general/decks/${deck.assetName}.tsx`);
      expect(wrapper, `${deck.slug} still references gamma.app`).not.toMatch(/gamma\.(app|site)/i);
    }
  });

  it("carries extracted deck text into the API snapshot for public decks", () => {
    // Without this a deck is a stack of images: zero text for a crawler or answer engine.
    // NDA decks are covered separately — their text is never committed.
    for (const deck of decks.filter((entry) => entry.accessLevel === "Public")) {
      const post = snapshot.find((entry) => entry.slug === deck.slug);
      expect(post?.sourceKind, `${deck.slug} sourceKind`).toBe("deck");
      expect(post?.bodyMarkdown?.length ?? 0, `${deck.slug} bodyMarkdown`).toBeGreaterThan(1000);
    }
  });
});

/**
 * This repository is public. The nine NDA decks contain fund allocations, AUM, mandate sizes and
 * per-position price targets, so none of that text may be committed — it lives only in the gated
 * GCS prefix and reaches approved readers through contentObject. Committing it once would put it
 * in git history permanently, where no later fix removes it.
 */
describe("NDA deck text never enters the public repository", () => {
  const ndaDecks = decks.filter((deck) => deck.accessLevel === "NDA");

  it("keeps no NDA deck text in the committed text directory", () => {
    const committed = ndaDecks
      .map((deck) => `content/decks/text/${deck.assetName}.md`)
      .filter((path) => existsSync(join(repoRoot, path)));
    expect(committed).toEqual([]);
  });

  it("gitignores the gated text directory", () => {
    expect(read(".gitignore")).toContain("content/decks/text-gated/");
  });

  it("gives NDA decks a description that discloses nothing", () => {
    // The manifest is committed, so an auto-extracted first paragraph would leak the deck's
    // opening claims — audience, mandate size, price targets.
    const sensitive =
      /consensus PT|prepared for LPs|BUY ?\/ ?ACCUMULATE|permanent capital mandate|LP update|alpha bets rank|\$[\d.]+ ?(billion|B)\b/i;
    for (const deck of ndaDecks) {
      expect(deck.description, `${deck.slug} has no description`).toBeTruthy();
      expect(deck.description, `${deck.slug} description leaks detail`).not.toMatch(sensitive);
    }
  });

  it("serves NDA deck bodies from the gated prefix, never inline", () => {
    for (const deck of ndaDecks) {
      const post = snapshot.find((entry) => entry.slug === deck.slug) as
        | { bodyMarkdown?: string; contentObject?: string }
        | undefined;
      expect(post?.bodyMarkdown ?? "", `${deck.slug} inlines its body`).toBe("");
      expect(post?.contentObject ?? "", `${deck.slug} contentObject`).toMatch(NDA_PREFIX);
    }
  });
});
