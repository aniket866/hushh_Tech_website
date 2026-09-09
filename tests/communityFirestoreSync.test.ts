import { describe, expect, it } from "vitest";

import { documentIdFor, planUpdate } from "../scripts/community/sync-community-firestore.mjs";
import { STATIC_COMMUNITY_POSTS } from "../api/community/staticPosts.generated.js";

type Post = { slug: string; accessLevel?: string; bodyMarkdown?: string; contentObject?: string };
const posts = STATIC_COMMUNITY_POSTS as Post[];

const doc = (fields: Record<string, string | number>) => ({
  fields: Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "number" ? { integerValue: String(value) } : { stringValue: value },
    ]),
  ),
});

/**
 * Firestore is the write side of the content system, not a mirror of the repo: bodies are editable
 * there and one document exists only there. Every case below is about the sync being a merge.
 */
describe("planUpdate is merge-safe", () => {
  it("repairs a day-first date that sorts wrong as a string", () => {
    const changes = planUpdate(
      { publishedAt: "2025-07-21" },
      doc({ publishedAt: "21/07/2025", title: "Aces of Aces" }),
    );
    expect(changes).toEqual({ publishedAt: "2025-07-21" });
  });

  it("writes nothing when the document already agrees", () => {
    expect(planUpdate({ publishedAt: "2025-07-21" }, doc({ publishedAt: "2025-07-21" }))).toEqual({});
  });

  it("never clears a non-empty value with an empty one", () => {
    const changes = planUpdate(
      { publishedAt: "", docFamily: "", docVersion: 0, sourceKind: "" },
      doc({ publishedAt: "2025-07-21", docFamily: "medallion-blueprint", docVersion: 2, sourceKind: "deck" }),
    );
    expect(changes).toEqual({});
  });

  it("never touches a field the repository is not authoritative for", () => {
    const changes = planUpdate(
      {
        publishedAt: "2026-08-30",
        title: "Repo title",
        description: "Repo description",
        bodyMarkdown: "# from the repo",
        category: "general",
        accessLevel: "Public",
      },
      doc({
        publishedAt: "2026-08-30",
        title: "Edited in Firestore",
        description: "Edited in Firestore",
        bodyMarkdown: "# edited in Firestore",
        category: "fund updates",
        accessLevel: "NDA",
      }),
    );
    expect(changes).toEqual({});
  });

  it("adds version identity that only the repository defines", () => {
    const changes = planUpdate(
      { publishedAt: "2026-08-30", docFamily: "medallion-blueprint", docVersion: 2 },
      doc({ publishedAt: "2026-08-30" }),
    );
    expect(changes).toEqual({ docFamily: "medallion-blueprint", docVersion: 2 });
  });
});

describe("document ids", () => {
  it("matches the convention already in the collection", () => {
    // Both live documents whose slug carries capitals; the id is lowercased.
    expect(documentIdFor("fund-compliance/sec-report-regD-filling")).toBe(
      "static-fund-compliance-sec-report-regd-filling",
    );
    expect(documentIdFor("legal/limited-partnership-agreement-LPA")).toBe(
      "static-legal-limited-partnership-agreement-lpa",
    );
    expect(documentIdFor("daily-market-update/10-apr-2025")).toBe("static-daily-market-update-10-apr-2025");
  });

  it("contains no slash, which a Firestore id cannot", () => {
    for (const post of posts) expect(documentIdFor(post.slug)).not.toContain("/");
  });

  it("assigns every snapshot post a distinct id", () => {
    // A collision would make one post silently overwrite another on insert.
    const ids = posts.map((post) => documentIdFor(post.slug));
    expect(ids.length).toBe(new Set(ids).size);
  });
});

/**
 * The sync writes into a collection the NDA gate reads from, so NDA bodies belong there — but only
 * by reference. Deck text for gated material lives behind the gated GCS prefix and must never be
 * carried inline through the snapshot, which is committed to a repository whose visibility has
 * already flipped once.
 */
describe("gated material stays by reference", () => {
  it("carries no NDA body text in the snapshot the sync writes from", () => {
    const inlined = posts
      .filter((post) => post.accessLevel === "NDA")
      .filter((post) => (post.bodyMarkdown || "").trim().length > 0)
      .map((post) => post.slug);
    expect(inlined).toEqual([]);
  });

  it("points every gated deck at the gated prefix", () => {
    const gated = posts.filter(
      (post) => post.accessLevel === "NDA" && (post.contentObject || "").length > 0,
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const post of gated) expect(post.contentObject).toMatch(/^gated\//);
  });
});
