/**
 * Generates public/llms.txt — the llmstxt.org convention: a single, curated, plain-text map of
 * the site for language models and answer engines.
 *
 * The site is a client-rendered SPA. Even with the per-route head injection in
 * api/seo/documentHead.js, an answer engine still has to discover 130+ community URLs one at a
 * time and guess which matter. This file hands it the whole public library in one request, newest
 * first, with a real description per entry.
 *
 * Built from the same deduplicated, access-filtered post set the API serves, so a superseded
 * edition never appears and an NDA post never appears at all.
 *
 * IMPORTANT: .gcloudignore excludes *.txt with a single "!dist/robots.txt" exception, so
 * "!dist/llms.txt" must stay alongside it or this file will not reach the container.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { staticPosts } from "../api/community/content-service.js";
import { comparePublishedAtDesc, selectLatestVersions } from "../api/community/postVersions.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "public/llms.txt");

const SITE_URL = "https://hushhtech.com";

const SUMMARY =
  "HushhTech is an AI-first investment firm building a portfolio of exceptional, " +
  "free-cash-flow compounding businesses for the long term — Berkshire Hathaway's discipline " +
  "run on an AI research and execution stack. This file indexes the firm's public research, " +
  "fund commentary and investor education.";

const KEY_PAGES = [
  ["/", "Home", "What HushhTech is and how it invests."],
  ["/discover-fund-a", "Fund A", "The fund's thesis, structure and portfolio design."],
  ["/about/philosophy", "Philosophy", "Simplicity, humility and cost-efficiency as investment principles."],
  ["/about/leadership", "Leadership", "The people building HushhTech."],
  ["/community", "Community", "The full research and commentary library."],
  ["/faq", "FAQ", "Common questions on eligibility, fees and process."],
  ["/risk-disclosures", "Risk disclosures", "Risk information for prospective and current investors."],
];

/** One line, no newlines, and short enough to stay scannable. */
const oneLine = (value, limit = 220) => {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
};

const main = () => {
  // staticPosts already filters to Public and non-draft; selectLatestVersions drops superseded
  // editions so a model is never handed two versions of the same document.
  const posts = selectLatestVersions(staticPosts("Public")).sort(comparePublishedAtDesc);

  const byCategory = new Map();
  for (const post of posts) {
    const category = post.category || "general";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(post);
  }

  const sections = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, entries]) => {
      const title = category.replace(/\b\w/g, (c) => c.toUpperCase());
      const lines = entries.map((post) => {
        const description = oneLine(post.description);
        const date = post.publishedAt ? ` (${post.publishedAt})` : "";
        return `- [${oneLine(post.title, 120)}](${SITE_URL}/community/${post.slug})${date}${
          description ? `: ${description}` : ""
        }`;
      });
      return `## ${title}\n\n${lines.join("\n")}`;
    });

  const content = `# HushhTech

> ${oneLine(SUMMARY, 600)}

## Key pages

${KEY_PAGES.map(([path, title, description]) => `- [${title}](${SITE_URL}${path}): ${description}`).join("\n")}

${sections.join("\n\n")}

## Notes

- Investor material covering specific fund vehicles, allocations or return figures sits behind an
  NDA gate and is deliberately absent from this index.
- Where a document has been reissued, only the current edition is listed; earlier editions remain
  reachable at their own URLs and point their canonical at the current one.
- Generated from the same post data the site's API serves. Contact: support@hushh.ai
`;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(
    `✅ llms.txt generated — ${posts.length} public posts across ${byCategory.size} categories`,
  );
};

main();
