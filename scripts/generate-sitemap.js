/**
 * Generates public/sitemap.xml.
 *
 * The previous version concatenated four sources — a hardcoded static list, a hardcoded array of
 * 52 community URLs, a directory scan of src/content/posts, and a committed Firestore slug
 * snapshot — and de-duplicated only within one of them. The result was 258 entries covering 204
 * unique URLs, with a dead branch reading a file that does not exist, and `lastmod` taken from
 * file mtime, so a fresh clone rewrote every date and told search engines the whole site had
 * changed.
 *
 * This version has one source of truth: the same deduplicated, access-filtered post set the API
 * and llms.txt use, plus the public route table in api/seo/documentHead.js. A superseded edition
 * never appears, an NDA post never appears, and noindex routes are excluded so the sitemap stops
 * contradicting the robots rules.
 *
 * `lastmod` is the post's own publishedAt. For static pages it is sticky: the previous value is
 * reused so routine rebuilds do not churn dates.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

import { staticPosts } from "../api/community/content-service.js";
import {
  comparePublishedAtDesc,
  normalizePublishedAt,
  selectLatestVersions,
} from "../api/community/postVersions.js";
import { STATIC_ROUTES, isNoindexPath } from "../api/seo/documentHead.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = "https://hushhtech.com";
const outputPath = path.join(__dirname, "../public/sitemap.xml");

/** Public routes that have no head entry but are still worth indexing. */
const EXTRA_ROUTES = [
  "/services/consumers",
  "/services/business",
  "/developer-docs",
  "/investor-guide",
  "/career-privacy-policy",
];

const PRIORITY = { "/": "1.0", "/community": "0.9", "/discover-fund-a": "0.9" };

/**
 * Reuse the previous run's lastmod for static pages so a rebuild does not restamp every URL.
 * Reads the committed sitemap from git first, falling back to the working tree.
 */
const previousLastMods = () => {
  const parse = (xml) => {
    const map = new Map();
    for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) || []) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
      const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1];
      if (loc && lastmod) map.set(loc, lastmod);
    }
    return map;
  };

  try {
    return parse(execSync("git show HEAD:public/sitemap.xml", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    try {
      return parse(fs.readFileSync(outputPath, "utf8"));
    } catch {
      return new Map();
    }
  }
};

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const main = () => {
  const previous = previousLastMods();
  const today = new Date().toISOString().slice(0, 10);
  const entries = new Map();

  const add = (route, { lastmod, changefreq, priority }) => {
    if (isNoindexPath(route)) return;
    const loc = `${SITE_URL}${route}`;
    if (entries.has(loc)) return; // first writer wins; one URL, one entry
    entries.set(loc, { loc, lastmod, changefreq, priority });
  };

  for (const route of [...STATIC_ROUTES.keys(), ...EXTRA_ROUTES]) {
    const loc = `${SITE_URL}${route}`;
    add(route, {
      lastmod: previous.get(loc) || today,
      changefreq: route === "/" || route === "/community" ? "daily" : "monthly",
      priority: PRIORITY[route] || "0.7",
    });
  }

  const posts = selectLatestVersions(staticPosts("Public")).sort(comparePublishedAtDesc);
  for (const post of posts) {
    add(`/community/${post.slug}`, {
      lastmod: normalizePublishedAt(post.publishedAt) || previous.get(`${SITE_URL}/community/${post.slug}`) || today,
      changefreq: "monthly",
      priority: "0.8",
    });
  }

  const urls = [...entries.values()]
    .map(
      ({ loc, lastmod, changefreq, priority }) => `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`,
    )
    .join("\n");

  fs.writeFileSync(
    outputPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`,
  );

  console.log(
    `✅ sitemap.xml generated — ${entries.size} unique URLs ` +
      `(${posts.length} community posts, ${entries.size - posts.length} pages)`,
  );
};

main();
