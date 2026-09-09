import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATIC_COMMUNITY_POSTS } from "../api/community/staticPosts.generated.js";
import { normalizePublishedAt } from "../api/community/postVersions.js";

const repoRoot = join(__dirname, "..");
const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

type SnapshotPost = {
  slug: string;
  title: string;
  publishedAt: string;
  sourceKind?: string;
  bodyMarkdown?: string;
};

const snapshot = STATIC_COMMUNITY_POSTS as SnapshotPost[];

/**
 * src/data/posts.ts ends with `...communityBlogPostList`, a spread of an imported
 * array. generate-community-snapshot.mjs parses that file as text and cannot see
 * through a spread, so for a while the snapshot held 138 posts while the runtime array
 * held 170 — the browser rendered the missing 32 from the bundle while the API, the
 * sitemap and every crawler saw a library that stopped at 2026-03-01.
 *
 * Nothing failed when that happened, which is why it went unnoticed. These cases fail.
 */
describe("community snapshot coverage", () => {
  const blogSource = read("src/data/communityBlogPosts.ts");
  const blogSlugs = [...blogSource.matchAll(/"slug":\s*"([^"]+)"/g)].map((match) => match[1]);
  const postsSource = read("src/data/posts.ts");
  const inlineSlugs = [...postsSource.matchAll(/\n\s*slug:\s*'([^']+)'/g)].map((match) => match[1]);
  const snapshotSlugs = new Set(snapshot.map((post) => post.slug));

  it("finds blog posts to check", () => {
    expect(blogSlugs.length).toBeGreaterThan(0);
    expect(inlineSlugs.length).toBeGreaterThan(0);
  });

  it("includes every post from communityBlogPosts.ts", () => {
    const missing = blogSlugs.filter((slug) => !snapshotSlugs.has(slug));
    expect(missing, `regenerate with: npm run build:community`).toEqual([]);
  });

  it("includes every inline post from posts.ts", () => {
    const missing = inlineSlugs.filter((slug) => !snapshotSlugs.has(slug));
    expect(missing, `regenerate with: npm run build:community`).toEqual([]);
  });

  it("carries markdown bodies for the blog posts so crawlers get real text", () => {
    for (const slug of blogSlugs) {
      const post = snapshot.find((item) => item.slug === slug);
      expect(post?.sourceKind, `${slug} should be an article`).toBe("article");
      expect(post?.bodyMarkdown?.length, `${slug} should carry a body`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate slugs", () => {
    expect(snapshotSlugs.size).toBe(snapshot.length);
  });

  it("stores every published date in ISO form", () => {
    // Raw DD/MM/YYYY sorted above every 2026 date under the API's string comparison,
    // which put a July 2025 post at the top of the live response.
    const malformed = snapshot
      .filter((post) => normalizePublishedAt(post.publishedAt) !== post.publishedAt)
      .map((post) => `${post.slug}: ${post.publishedAt}`);
    expect(malformed).toEqual([]);
  });
});
