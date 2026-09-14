#!/usr/bin/env node
/**
 * Turns a staged Gamma export into the structure the deck reader renders.
 *
 * Why not the PDF text
 * --------------------
 * The first pass extracted deck text with pdf-parse. That threw away everything except words, and
 * mangled the words: a 35-card deck came out as 32 flat headings, zero images, zero tables, and
 * prose broken wherever the PDF happened to wrap a line ("02 Part II — The Machine How he built
 * Renaissance:"). Gamma's own export carries the real document — heading levels, images with alt
 * text, tables with header rows, callouts, stat blocks — so this reads that instead.
 *
 * What comes out
 * --------------
 * content/decks/cards/<assetName>.json for a public deck, or the gitignored cards-gated/ for an
 * NDA one, holding one entry per card: a stable id, a title, and sanitised HTML.
 *
 * Sanitising is not optional. The reader renders this through dangerouslySetInnerHTML, so the
 * converter emits an allowlist of tags and attributes and nothing else — Gamma's custom elements
 * (smart-layout, columns, labels, display) are mapped onto plain HTML, and every styling attribute
 * is dropped so the site's own typography applies.
 *
 * Usage:
 *   node scripts/community/convert-gamma-export.mjs             # every staged deck
 *   node scripts/community/convert-gamma-export.mjs --deck general/the-medallion-blueprint
 *   node scripts/community/convert-gamma-export.mjs --stats     # what each deck yielded
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(root, "content/decks/manifest.json");
const STAGE = join(root, "content/decks/gamma-export");
// Written by mirror-deck-images.mjs: origin CDN URL -> self-hosted asset path, or null for an
// image that could not be mirrored and should be dropped. Applied here so the two scripts can run
// in either order — converting after a mirror used to restore every CDN hotlink. The gated half is
// a separate, gitignored file: it names the public origin of every NDA deck image.
//
// These are kept APART, never merged. Both are keyed by the origin CDN URL, and a stock photo used
// by a public deck and an NDA deck appears in both under the same key. Merging them with
// Object.assign let the gated entry win for every deck, so a public deck's card ended up pointing
// at /api/community/assets/gated/... -- a 401 and a broken image for every reader, and a public
// page holding a pointer into gated storage. Two decks shipped that way to production.
const PUBLIC_MEDIA_MAP = join(root, "content/decks/media-map.json");
const GATED_MEDIA_MAP = join(root, "content/decks/media-map-gated.json");

/* ------------------------------------------------------------------------------------------- */
/* HTML normalisation                                                                            */
/* ------------------------------------------------------------------------------------------- */

/**
 * Gamma's own elements, mapped onto plain HTML.
 *
 * `<h1>` becomes `<h2>` because the page already has an `<h1>` — the deck title — and a document
 * with 35 `<h1>`s has no outline at all, which is exactly what a heading-driven answer engine
 * reads. Everything shifts down one level to keep the hierarchy Gamma expressed.
 */
const TAG_MAP = {
  display: "h2",
  h1: "h2",
  h2: "h3",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  // Gamma's layout blocks. The variant and the stat figure are carried through as data attributes
  // so the reader can render a stat row as a stat row rather than as anonymous paragraphs — see
  // ADDED_ATTRS and the `data-layout` styling in DeckReader.
  "smart-layout": "div",
  "smart-layout-item": "div",
  columns: "div",
  // Gamma's chip row. Mapped to a marked paragraph and marked spans so the reader can render them
  // as pills; as bare <strong> they concatenated into unreadable runs like
  // "Institutional GradeGlobal Permanent CapitalAAA+ Asset Quality".
  labels: "p",
  label: "span",
  section: "section",
};

/** Everything the reader is allowed to receive. Anything else is unwrapped or dropped. */
const ALLOWED = new Set([
  "section", "div", "p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "b", "strong", "i", "em", "u", "s", "code", "pre", "br", "hr",
  "a", "img", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "span",
]);

/** Dropped entirely, content and all: decorative or not renderable outside Gamma. */
const DROPPED = new Set(["icon", "video", "iframe", "script", "style", "svg", "button", "input"]);

const ATTRS = {
  a: ["href", "title"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  p: ["data-badges"],
  span: ["data-badge"],
  div: ["data-layout", "data-figure"],
};

/** Attributes the converter adds itself, so the reader can style Gamma's own block semantics. */
const ADDED_ATTRS = { labels: ' data-badges="true"', label: ' data-badge="true"' };

/**
 * Attributes derived from the source element rather than added blind.
 *
 * `smart-layout-item label="$2.5B"` is how Gamma stores the headline figure of a stat block — the
 * number itself, with the `<h4>` beside it as its caption. There are 256 of them across these
 * decks and every one was being dropped, because `label` was not on the allowlist: "$2.5B",
 * "66%", "60K+", "$574B" vanished from the rendered page and from the crawler-visible body alike.
 * Those are the citable facts in a research deck.
 */
const DERIVED_ATTRS = {
  "smart-layout": (attrs) => (attrs.variant ? ` data-layout="${escapeAttr(attrs.variant)}"` : ""),
  "smart-layout-item": (attrs) => (attrs.label ? ` data-figure="${escapeAttr(decodeEntities(attrs.label))}"` : ""),
};

/**
 * The intrinsic size Gamma records on every image, as real `width`/`height` attributes.
 *
 * Gamma stores it as `meta='{"width":1024,"height":1024}'`. Without it the browser learns an
 * image's size only once the bytes arrive, so every card reflows as its image loads — the text
 * below jumps, which is both the worst kind of reading experience and a direct CLS penalty on the
 * pages this work exists to rank. With the attributes present the box is reserved from first paint
 * and the layout never moves; it also means a card whose image fails still occupies its own space
 * instead of collapsing.
 *
 * Mirroring resizes but preserves aspect ratio, so the recorded numbers stay correct for the copy
 * actually served.
 */
const imageDimensions = (attrs) => {
  if (!attrs.meta) return "";
  try {
    const meta = JSON.parse(decodeEntities(attrs.meta));
    const width = Number(meta?.width);
    const height = Number(meta?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
    return ` width="${Math.round(width)}" height="${Math.round(height)}"`;
  } catch {
    return "";
  }
};

const decodeEntities = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const readAttrs = (raw) => {
  const attrs = {};
  for (const match of raw.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
};

/**
 * Rewrites a fragment of Gamma HTML into the allowlist.
 *
 * A single pass over the tag stream rather than a DOM parse: the export is machine-generated and
 * well formed, and pulling in a parser for this would be the larger risk. Unknown tags are
 * unwrapped (their children survive), dropped tags take their subtree with them.
 */
const normalizeHtml = (html) => {
  let output = "";
  let index = 0;
  const dropStack = [];

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      if (!dropStack.length) output += html.slice(index);
      break;
    }
    if (!dropStack.length) output += html.slice(index, open);

    const close = html.indexOf(">", open);
    if (close === -1) break;
    const rawTag = html.slice(open + 1, close);
    index = close + 1;

    const isClosing = rawTag.startsWith("/");
    const name = (isClosing ? rawTag.slice(1) : rawTag).trim().split(/[\s/>]/)[0].toLowerCase();

    if (DROPPED.has(name)) {
      if (isClosing) dropStack.pop();
      else if (!rawTag.endsWith("/")) dropStack.push(name);
      continue;
    }
    if (dropStack.length) continue;

    const mapped = TAG_MAP[name] || name;
    if (!ALLOWED.has(mapped)) continue; // unwrap: children still render

    if (isClosing) {
      output += `</${mapped}>`;
      continue;
    }

    const attrs = readAttrs(rawTag);
    const kept = (ATTRS[mapped] || [])
      .filter((key) => attrs[key])
      .map((key) => ` ${key}="${escapeAttr(decodeEntities(attrs[key]))}"`)
      .join("");

    if (mapped === "img") {
      // `kept` drops an allowlisted attribute the source tag does not carry, so an image whose
      // src did not survive that filter would otherwise ship as `<img alt="..." />` — a broken
      // image placeholder on a live page rather than a missing one. No source, no element.
      if (attrs.src) {
        output += `<img${kept}${imageDimensions(attrs)} loading="lazy" decoding="async" />`;
      }
      continue;
    }
    if (mapped === "br" || mapped === "hr") {
      output += `<${mapped} />`;
      continue;
    }
    output += `<${mapped}${kept}${ADDED_ATTRS[name] || ""}${DERIVED_ATTRS[name]?.(attrs) || ""}>`;
  }

  return output
    .replace(/<(p|h[2-6]|li|td|th)>\s*<\/\1>/g, "")   // empties left by dropped icons
    .replace(/<div>\s*<\/div>/g, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();
};

/**
 * Gamma renders a table's header row as ordinary cells — sometimes flagged with
 * `header-row="true"`, sometimes only styled, with every cell fully bold. Screen readers and
 * answer engines both key on the real elements, so promote the row when either signal is present.
 * "Every cell in row one is entirely bold" is the conservative test: a data row with one bold
 * figure in it does not qualify, so real data is never mislabelled as headers.
 */
const everyCellBold = (row) => {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
  if (cells.length < 2) return false;
  return cells.every((cell) => {
    const text = cell.replace(/<[^>]+>/g, "").trim();
    if (!text) return true; // a blank corner cell is normal in a header row
    return /<(?:b|strong)>/.test(cell) && cell.replace(/<\/?(?:b|strong)>/g, "").replace(/<[^>]+>/g, "").trim() === text;
  });
};

const promoteTableHeaders = (html, flagged) => {
  let index = 0;
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (whole, inner) => {
    const isFlagged = flagged[index];
    index += 1;
    const firstRow = /<tbody><tr>([\s\S]*?)<\/tr>/.exec(inner);
    if (!firstRow) return whole;
    if (!isFlagged && !everyCellBold(firstRow[1])) return whole;
    const cells = firstRow[1]
      .replace(/<td([^>]*)>/g, "<th$1>")
      .replace(/<\/td>/g, "</th>")
      .replace(/<\/?(?:p|b|strong)>/g, "");
    // `inner` is the table's contents, so the closing tag has to be put back — dropping it left
    // every promoted table unclosed, which the markdown converter could not match and a browser
    // could only guess at.
    const rest = inner.slice(firstRow.index + firstRow[0].length);
    return `<table><thead><tr>${cells}</tr></thead><tbody>${rest}</table>`;
  });
};

/**
 * Rewrites image sources to their mirrored copies, and removes the ones the mirror could not
 * fetch. Without this, a re-export puts CDN URLs back into cards that were already self-hosted —
 * and for a gated deck that means its images stop being gated.
 */
const applyMediaMap = (html, mediaMap) => {
  let output = html;
  for (const [origin, target] of Object.entries(mediaMap)) {
    for (const form of new Set([origin, origin.replace(/&/g, "&amp;")])) {
      if (!output.includes(form)) continue;
      if (target === null) {
        const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        output = output.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*/?>`, "g"), "");
      } else {
        output = output.split(form).join(target);
      }
    }
  }
  return output;
};

const textOf = (html) =>
  decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------------------------------- */
/* Card extraction                                                                               */
/* ------------------------------------------------------------------------------------------- */

/** Splits the export into cards. Sections nest, so this tracks depth rather than regex-matching. */
const splitCards = (body) => {
  const cards = [];
  const openTag = /<section\b([^>]*)>/g;
  let match;
  while ((match = openTag.exec(body))) {
    const attrs = readAttrs(match[1]);
    let depth = 1;
    let cursor = openTag.lastIndex;
    while (depth > 0) {
      const next = /<\/?section\b[^>]*>/g;
      next.lastIndex = cursor;
      const tag = next.exec(body);
      if (!tag) { cursor = body.length; break; }
      depth += tag[0].startsWith("</") ? -1 : 1;
      cursor = next.lastIndex;
    }
    const inner = body.slice(openTag.lastIndex, Math.max(openTag.lastIndex, cursor - "</section>".length));
    cards.push({ id: attrs.id || `card-${cards.length + 1}`, inner });
    openTag.lastIndex = cursor;
  }
  return cards;
};

/**
 * The card's own title.
 *
 * Usually Gamma's first `<h1>` or `<display>`, but a continuation card — the second of a pair
 * covering one topic — often has no top-level heading at all. Thirteen cards across two decks came
 * out untitled, which meant thirteen blank rows in the contents rail. Fall back to the card's first
 * subheading, which in practice is exactly the label a reader wants ("Apple (AAPL) · Hold").
 */
const titleOfCard = (inner) => {
  const primary = /<(?:h1|display)\b[^>]*>([\s\S]*?)<\/(?:h1|display)>/.exec(inner);
  if (primary) return textOf(primary[1]);
  const secondary = /<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/.exec(inner);
  return secondary ? textOf(secondary[1]) : "";
};

/** A slug that stays stable across re-exports, so anchors in shared links keep working. */
const anchorFor = (title, index) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return base ? `${String(index + 1).padStart(2, "0")}-${base}` : `card-${index + 1}`;
};

/**
 * Gated decks a PUBLIC deck's cards point into. Empty for a gated deck, which is supposed to.
 */
export const leakedGatedReferences = (cards, isGated) => {
  if (isGated) return [];
  return [
    ...new Set(
      [
        ...JSON.stringify(cards).matchAll(
          /\/api\/community\/assets\/gated\/decks\/([a-z0-9-]+)\//g,
        ),
      ].map((match) => match[1]),
    ),
  ];
};

export const convertExport = (body, mediaMap = {}) => {
  const cards = splitCards(body).map(({ id, inner }, index) => {
    const title = titleOfCard(inner);
    // The title is rendered as the section heading, so remove it from the body to avoid a
    // duplicate heading immediately under itself.
    const withoutTitle = /<(?:h1|display)\b/.test(inner)
      ? inner.replace(/<(?:h1|display)\b[^>]*>[\s\S]*?<\/(?:h1|display)>/, "")
      : inner.replace(/<h[2-4]\b[^>]*>[\s\S]*?<\/h[2-4]>/, "");
    // Read the header-row flags before normalising, which drops the attribute along with the rest
    // of Gamma's styling.
    const headerTables = [...withoutTitle.matchAll(/<table\b([^>]*)>/g)].map((match) =>
      /header-row="true"/.test(match[1]),
    );
    const html = applyMediaMap(promoteTableHeaders(normalizeHtml(withoutTitle), headerTables), mediaMap);
    return {
      id,
      anchor: anchorFor(title, index),
      title,
      html,
      text: textOf(html),
      images: [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => decodeEntities(match[1])),
    };
  });
  return cards.filter((card) => card.title || card.text.length > 0);
};

/**
 * Markdown for the snapshot body, the crawler-visible `<noscript>`, and anything else that reads
 * `bodyMarkdown` rather than the cards.
 *
 * Tables are converted first and whole. Doing it inline with the other replacements turns every
 * cell into its own paragraph — the row `| NVDA | Goldman Sachs | $137.5M |` came out as three
 * separate lines, which is worse than no table at all for a reader and for anything parsing it.
 */
const tableToMarkdown = (html) => {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/g)].map((cell) =>
      decodeEntities(cell[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => [...row, ...Array(width - row.length).fill("")];
  const hasHeader = /<thead>/.test(html);
  const header = hasHeader ? pad(rows[0]) : Array(width).fill("");
  const body = hasHeader ? rows.slice(1) : rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ].join("\n");
};

/** Placeholder while tables are lifted out of the prose. Cannot appear in deck copy. */
const TABLE_SENTINEL = "@@HUSHH_TABLE@@";

export const cardsToMarkdown = (deckTitle, cards) => {
  const blocks = [`# ${deckTitle}`];
  for (const card of cards) {
    if (card.title) blocks.push(`## ${card.title}`);

    let html = card.html;
    const tables = [];
    html = html.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
      tables.push(tableToMarkdown(table));
      return `${TABLE_SENTINEL}${tables.length - 1}${TABLE_SENTINEL}`;
    });

    const prose = html
      // Surface the stat figure as text immediately before its caption, so "$2.5B" appears in the
      // body a crawler reads rather than only as an attribute on a div.
      .replace(/<div data-figure="([^"]*)">/g, (_, figure) => `\n\n**${decodeEntities(figure)}** — `)
      .replace(/<h([2-6])[^>]*>/g, (_, level) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<\/h[2-6]>/g, "\n\n")
      .replace(/<li[^>]*>/g, "\n- ")
      .replace(/<blockquote[^>]*>/g, "\n\n> ")
      .replace(/<\/(p|div|ul|ol|blockquote|section)>/g, "\n\n")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((line) => decodeEntities(line).replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const restored = prose.replace(
      new RegExp(`${TABLE_SENTINEL}(\\d+)${TABLE_SENTINEL}`, "g"),
      (_, index) => `\n\n${tables[Number(index)]}\n`,
    );
    if (restored) blocks.push(restored);
  }
  return `${blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
};

/* ------------------------------------------------------------------------------------------- */

const main = () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const readMap = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  // A deck resolves its images against the map for its own access level and no other. A public
  // deck must never resolve to a gated object, and a gated deck resolving to a public one would
  // stop being gated -- isNdaAsset() reads the object prefix, so the prefix IS the access level.
  const mediaMapsByAccess = {
    Public: readMap(PUBLIC_MEDIA_MAP),
    NDA: readMap(GATED_MEDIA_MAP),
  };
  const only = process.argv.includes("--deck") ? process.argv[process.argv.indexOf("--deck") + 1] : "";
  const publicDir = join(root, "content/decks/cards");
  const gatedDir = join(root, "content/decks/cards-gated");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(gatedDir, { recursive: true });

  let converted = 0;
  let manifestChanged = false;
  for (const deck of manifest.decks) {
    if (only && deck.slug !== only) continue;
    const stagePath = join(STAGE, `${deck.gammaId}.html`);
    if (!existsSync(stagePath)) continue;

    const isGated = deck.accessLevel === "NDA";
    const cards = convertExport(
      readFileSync(stagePath, "utf8"),
      mediaMapsByAccess[isGated ? "NDA" : "Public"],
    );
    if (!cards.length) {
      console.error(`  ${deck.slug}: export produced no cards`);
      process.exitCode = 1;
      continue;
    }

    // Belt and braces. The separated maps above are the fix; this is the assertion that the fix
    // held, because the failure is silent everywhere else -- valid markup, a 200 route, and a
    // crawler body built from the markdown rather than the cards.
    const leaked = leakedGatedReferences(cards, isGated);
    if (leaked.length) {
      console.error(
        `  ${deck.slug}: public cards reference gated media (${leaked.join(", ")})`,
      );
      process.exitCode = 1;
      continue;
    }

    const directory = deck.accessLevel === "NDA" ? gatedDir : publicDir;
    writeFileSync(
      join(directory, `${deck.assetName}.json`),
      `${JSON.stringify({ gammaId: deck.gammaId, slug: deck.slug, title: deck.title, cards }, null, 2)}\n`,
    );

    // The markdown body the snapshot and the crawler-visible head are built from. Rewriting it here
    // rather than leaving the pdf-parse output in place is the point of this converter: the same
    // deck goes from prose broken at every PDF line wrap to the document Gamma actually holds.
    const textDirectory = join(root, deck.accessLevel === "NDA" ? "content/decks/text-gated" : "content/decks/text");
    mkdirSync(textDirectory, { recursive: true });
    writeFileSync(join(textDirectory, `${deck.assetName}.md`), cardsToMarkdown(deck.title, cards));

    // cardCount is the reading length; pageCount is how many slide images exist in GCS. They are
    // equal for a deck that came from a Gamma slide export and zero-vs-N for one that never had one.
    if (deck.cardCount !== cards.length) {
      deck.cardCount = cards.length;
      manifestChanged = true;
    }

    const words = cards.reduce((total, card) => total + card.text.split(/\s+/).filter(Boolean).length, 0);
    const images = cards.reduce((total, card) => total + card.images.length, 0);
    const tables = cards.filter((card) => card.html.includes("<table")).length;
    console.log(
      `  ${deck.slug.padEnd(48)} ${String(cards.length).padStart(3)} cards  ` +
        `${String(words).padStart(6)} words  ${String(images).padStart(3)} images  ${tables} tables`,
    );
    converted += 1;
  }
  if (manifestChanged) {
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log("\nupdated cardCount in content/decks/manifest.json");
  }
  console.log(`\nconverted ${converted} deck(s)`);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
