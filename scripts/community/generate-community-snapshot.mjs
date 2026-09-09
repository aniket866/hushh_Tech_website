import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "../..");
const postsPath = join(root, "src/data/posts.ts");
const blogPostsPath = join(root, "src/data/communityBlogPosts.ts");
const deckManifestPath = join(root, "content/decks/manifest.json");
const deckTextDir = join(root, "content/decks/text");
const outputPath = join(root, "api/community/staticPosts.generated.js");

const source = readFileSync(postsPath, "utf8");

const importMap = new Map();
const importRegex = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?/gm;
let importMatch;
while ((importMatch = importRegex.exec(source))) {
  importMap.set(importMatch[1], importMatch[2]);
}

const stringField = (block, field) => {
  const match = block.match(new RegExp(`${field}:\\s*(['"\`])([\\s\\S]*?)\\1\\s*,`));
  return match?.[2]
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .trim();
};

const componentField = (block) => {
  const identifierMatch = block.match(/Component:\s*([A-Za-z_$][\w$]*)\s*,/);
  if (identifierMatch) return identifierMatch[1];

  return stringField(block, "Component") || "";
};

const mediaItemsField = (block) => {
  const match = block.match(/mediaItems:\s*\[([\s\S]*?)\]\s*,/);
  if (!match) return undefined;

  const values = [];
  const stringRegex = /(['"`])([\s\S]*?)\1/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(match[1]))) {
    values.push(
      stringMatch[2]
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .trim(),
    );
  }

  return values.length ? values : undefined;
};

const resolveComponentPath = (componentName) => {
  const importPath = importMap.get(componentName);
  if (!importPath) return "";

  const relativePath = importPath
    .replace(/^\.\.\//, "src/")
    .replace(/^\.\//, "src/data/");

  for (const extension of [".tsx", ".jsx", ".ts", ".js"]) {
    const candidate = join(root, `${relativePath}${extension}`);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Keep trying known component extensions.
    }
  }

  return "";
};

const numberField = (block, field) => {
  const match = block.match(new RegExp(`${field}:\\s*(-?\\d+(?:\\.\\d+)?)\\s*,`));
  return match ? Number(match[1]) : undefined;
};

const stringArrayField = (block, field) => {
  const match = block.match(new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]\\s*,`));
  if (!match) return undefined;

  const values = [];
  const stringRegex = /(['"`])([\s\S]*?)\1/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(match[1]))) values.push(stringMatch[2].trim());
  return values.length ? values : undefined;
};

const sourceKindFor = (post) => {
  // An explicit sourceKind wins. Decks served from exported page images in GCS carry
  // no gamma.app URL, so the grep below would misfile them as "legacy" and they would
  // lose the full-bleed deck layout in src/pages/community/post-ui.tsx.
  if (post.sourceKind) return post.sourceKind;
  if (post.pdfUrl) return "document";

  const componentPath = resolveComponentPath(post.componentName);
  if (!componentPath) return "legacy";

  const componentSource = readFileSync(componentPath, "utf8");
  if (/gamma\.(app|site)/i.test(componentSource)) return "deck";

  return "legacy";
};

const postBlocks = source
  .slice(source.indexOf("export const posts"))
  .split(/\n\s*{\s*\n/g)
  .slice(1)
  .map((block) => `{\n${block.split(/\n\s*},?\s*\n/)[0]}\n}`);

const posts = postBlocks
  .map((block) => {
    const slug = stringField(block, "slug");
    const title = stringField(block, "title");
    const publishedAt = stringField(block, "publishedAt");
    const description = stringField(block, "description");
    const category = stringField(block, "category");
    const accessLevel = stringField(block, "accessLevel") || "Public";
    const pdfUrl = stringField(block, "pdfUrl");
    const mediaItems = mediaItemsField(block);
    const componentName = componentField(block);

    if (!slug || !title || !publishedAt || !description || !category) {
      return null;
    }

    const post = {
      slug,
      title,
      publishedAt,
      description,
      category,
      accessLevel,
      componentName,
      pdfUrl,
      mediaItems,
      sourceKind: stringField(block, "sourceKind"),
      docFamily: stringField(block, "docFamily"),
      docVersion: numberField(block, "docVersion"),
      supersedes: stringArrayField(block, "supersedes"),
    };

    return {
      ...post,
      sourceKind: sourceKindFor(post),
    };
  })
  .filter(Boolean);

// src/data/posts.ts ends with `...communityBlogPostList`, a spread of an imported
// array. The block splitter above cannot see through a spread, so these 32 posts
// (2026-03-08 to 2026-05-30) were silently missing from the snapshot: the browser
// rendered them from the bundle while the API, the sitemap and every crawler saw a
// library that stopped at 2026-03-01.
//
// The array is generated JSON, so parse it directly rather than adding a TS loader
// to a script that also runs inside the Docker build.
const readCommunityBlogPosts = () => {
  const blogSource = readFileSync(blogPostsPath, "utf8");
  // Anchor past the `=` so the `[]` in the `CommunityBlogPost[]` annotation is skipped.
  const declaration = blogSource.indexOf("export const communityBlogPosts");
  const assignment = declaration === -1 ? -1 : blogSource.indexOf("=", declaration);
  const start = assignment === -1 ? -1 : blogSource.indexOf("[", assignment);
  const end = blogSource.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not locate the communityBlogPosts array in ${blogPostsPath}`);
  }
  return JSON.parse(blogSource.slice(start, end + 1));
};

// Mirrors CATEGORY in src/content/posts/community-blog/index.tsx so a post lands in
// the same category on both paths.
const BLOG_CATEGORY = {
  funds: "fund updates",
  general: "general",
  market: "market updates",
  "investor-relations": "investor relations & strategies",
  insights: "investment & financial strategies",
  product: "product updates",
};

// The browser renders these through a React component that appends a References
// block. Reproduce it as markdown so the API copy carries the same links and images.
const referencesMarkdown = (references) => {
  if (!Array.isArray(references) || !references.length) return "";
  const lines = references.map((reference) =>
    reference?.type === "image"
      ? `![${reference.label || "reference image"}](${reference.url})`
      : `- [${reference.label || reference.url}](${reference.url})`,
  );
  return `\n\n## References\n\n${lines.join("\n")}\n`;
};

const blogPosts = readCommunityBlogPosts().map((post) => ({
  slug: post.slug,
  title: post.title,
  publishedAt: post.publishedAt || "2026-06-04",
  description: post.description,
  category: BLOG_CATEGORY[post.category] || "general",
  accessLevel: "Public",
  componentName: "",
  pdfUrl: undefined,
  mediaItems: undefined,
  sourceKind: "article",
  docFamily: undefined,
  docVersion: undefined,
  supersedes: undefined,
  bodyMarkdown: `${post.body}${referencesMarkdown(post.references)}`,
}));

// Curated Gamma decks reach posts.ts through `...deckPostList`, another spread the block splitter
// cannot see. Read them from the manifest instead, and carry the extracted deck text as
// bodyMarkdown — a deck rendered as page images has no indexable text of its own, so without this
// a crawler or answer engine sees only the title.
const readDeckPosts = () => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(deckManifestPath, "utf8"));
  } catch {
    return [];
  }

  return (manifest.decks || [])
    // Reading cards are what makes a deck publishable. Slide images are optional: ten of these were
    // published as a live Gamma embed and have no page-image export, so pageCount is 0 for them.
    .filter((deck) => Number(deck.cardCount) > 0 || Number(deck.pageCount) > 0)
    .map((deck) => {
      // Public deck text is committed and inlined so crawlers get it straight from the API.
      // NDA deck text is not in this public repository at all: it lives only in the gated GCS
      // prefix, and contentObject makes the API stream it through the NDA check.
      //
      // The inlining is load-bearing and must stay. api/seo/documentHead.js imports `staticPosts`
      // directly rather than going through getCommunityPost, so it never runs withDetailContent
      // and never hydrates from contentObject — it reads bodyMarkdown or it renders nothing.
      // Dropping the inline copy to shrink this module took the crawler-visible body of every deck
      // from ~53,000 characters to 23, which is the one thing this whole surface exists to
      // produce. Measured, not assumed: the module's size was never the CI cost it looked like.
      //
      // Public decks also carry a contentObject now. It is inert while bodyMarkdown is present,
      // and it gives fetchGcsText a path to fall back on if a deck ever reaches the API without
      // its text.
      let bodyMarkdown = "";
      let contentObject = "";
      // A word count is not the words. Reading time is computed from the gated text for an NDA deck
      // so its card can say "42 min read" without the text itself ever entering this snapshot.
      let gatedMinutes = 0;
      if (deck.accessLevel === "NDA") {
        contentObject = `gated/decks/${deck.assetName}/index.md`;
        try {
          const gated = readFileSync(join(root, "content/decks/text-gated", `${deck.assetName}.md`), "utf8");
          gatedMinutes = Math.max(1, Math.round(gated.split(/\s+/).filter(Boolean).length / 240));
        } catch {
          // Not extracted locally; the card falls back to the card count alone.
        }
      } else {
        contentObject = `decks/${deck.assetName}/index.md`;
        try {
          bodyMarkdown = readFileSync(join(deckTextDir, `${deck.assetName}.md`), "utf8");
        } catch {
          // A deck with no extracted text still publishes; it just contributes no prose.
        }
      }
      return {
        contentObject,
        // Where convert-gamma-export.mjs published this deck's cards. Under the deck's own access
        // prefix, so isNdaAsset() gates the reading view exactly as it gates the page images.
        cardsObject: `${deck.accessLevel === "NDA" ? "gated/decks" : "decks"}/${deck.assetName}/cards.json`,
        slug: deck.slug,
        title: deck.title,
        publishedAt: deck.publishedAt,
        description: deck.description || "",
        category: deck.category,
        accessLevel: deck.accessLevel,
        componentName: "",
        pdfUrl: undefined,
        mediaItems: undefined,
        sourceKind: "deck",
        cardCount: Number(deck.cardCount ?? deck.pageCount) || 0,
        readingMinutes: gatedMinutes,
        docFamily: deck.docFamily,
        docVersion: deck.docVersion,
        supersedes: undefined,
        bodyMarkdown,
      };
    });
};

/**
 * Reading time, computed here rather than in the browser: the list response strips bodies, so the
 * client has nothing to count. ~240 wpm, which is the usual estimate for considered non-fiction.
 */
const readingMinutesFor = (post) => {
  const words = String(post.bodyMarkdown || "").split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return Math.max(1, Math.round(words / 240));
};

const deckPosts = readDeckPosts();

// posts.ts wins on a slug collision, matching the client, where the spreads are appended after the
// inline entries.
const bySlug = new Map();
for (const post of [...blogPosts, ...deckPosts, ...posts]) bySlug.set(post.slug, post);
const allPosts = [...bySlug.values()].map((post) => ({
  ...post,
  readingMinutes: Number(post.readingMinutes) || readingMinutesFor(post),
}));

const generated = `// Generated by scripts/community/generate-community-snapshot.mjs.
// Do not edit manually. This file is the Cloud Run API fallback when GCP content is unavailable.

export const STATIC_COMMUNITY_POSTS = ${JSON.stringify(allPosts, null, 2)};
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, generated);
console.log(
  `Generated ${allPosts.length} community posts ` +
    `(${posts.length} from posts.ts, ${blogPosts.length} from communityBlogPosts.ts, ` +
    `${deckPosts.length} decks) at ${outputPath}`,
);
