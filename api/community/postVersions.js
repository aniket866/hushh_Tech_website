/**
 * Document version selection for community posts.
 *
 * The same document gets republished under a new slug when it is rewritten — four
 * editions of "Sell the Wall", three of the prospectus, two of the PPM. Before this
 * module the only dedupe anywhere was a slug-keyed Map, which by definition cannot
 * collapse the same document published at two different slugs, so every edition
 * rendered as its own card.
 *
 * Three fields express the relationship:
 *   docFamily   stable identity of the document across reissues ("sell-the-wall")
 *   docVersion  monotonic within a family; higher wins
 *   supersedes  slugs this edition replaces, for provenance
 *
 * Superseded editions stay reachable at their URLs — no 404s, no link rot — but they
 * are dropped from listings and point their canonical at the current edition so search
 * engines consolidate on one URL instead of ranking editions against each other.
 *
 * This file is plain ESM so the Cloud Run API (which runs it directly under Node) and
 * the browser bundle can share one implementation. They previously disagreed: the API
 * sorted with localeCompare on the raw string while the client sorted on a parsed Date,
 * so the seven DD/MM/YYYY entries ordered differently on each path.
 */

/**
 * Converts a published date to ISO `YYYY-MM-DD` so lexicographic comparison, Date
 * parsing and display formatting all agree on the same ordering.
 *
 * Slash dates are day-first (`21/07/2025` is 21 July), matching parseDate in
 * src/utils/dateFormatter.ts. Anything unparseable becomes "" and sorts last,
 * rather than sorting above every real date as raw localeCompare did.
 */
export const normalizePublishedAt = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // "15/4/2025" or "15/07/2025 00:50" — day first.
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  return "";
};

/** Newest first. Undated posts sort last instead of first. */
export const comparePublishedAtDesc = (a, b) => {
  const left = normalizePublishedAt(a?.publishedAt || a?.date);
  const right = normalizePublishedAt(b?.publishedAt || b?.date);
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
};

const familyKeyOf = (post) =>
  typeof post?.docFamily === "string" && post.docFamily.trim() ? post.docFamily.trim() : "";

const versionOf = (post) => {
  const parsed = Number(post?.docVersion);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Picks the winning edition of a family: highest docVersion, then latest date, then
 * whichever came first in the input so the result is stable across runs.
 */
const isBetterEdition = (candidate, incumbent) => {
  const byVersion = versionOf(candidate) - versionOf(incumbent);
  if (byVersion !== 0) return byVersion > 0;

  const candidateDate = normalizePublishedAt(candidate?.publishedAt || candidate?.date);
  const incumbentDate = normalizePublishedAt(incumbent?.publishedAt || incumbent?.date);
  if (candidateDate !== incumbentDate) return candidateDate > incumbentDate;

  return false;
};

/**
 * Maps every slug to its family's current edition.
 *
 * Posts with no docFamily are their own family, so untagged content is never hidden —
 * tagging is opt-in and the default stays "show it".
 *
 * @returns Map<slug, {family, version, isLatest, latestSlug, latestTitle, latestPublishedAt}>
 */
export const buildVersionIndex = (posts) => {
  const list = Array.isArray(posts) ? posts.filter(Boolean) : [];
  const winners = new Map();

  for (const post of list) {
    const family = familyKeyOf(post);
    if (!family) continue;
    const incumbent = winners.get(family);
    if (!incumbent || isBetterEdition(post, incumbent)) winners.set(family, post);
  }

  const index = new Map();
  for (const post of list) {
    const family = familyKeyOf(post);
    const winner = family ? winners.get(family) : post;
    index.set(post.slug, {
      family,
      version: versionOf(post),
      isLatest: !family || winner.slug === post.slug,
      latestSlug: winner.slug,
      latestTitle: winner.title || "",
      latestPublishedAt: winner.publishedAt || winner.date || "",
    });
  }
  return index;
};

/**
 * Annotates each post with its version standing, leaving order untouched.
 *
 * Callers that render a listing then filter on `isLatestVersion`; the detail route
 * keeps superseded posts so their pages still resolve and can link forward.
 */
export const decorateVersions = (posts) => {
  const list = Array.isArray(posts) ? posts.filter(Boolean) : [];
  const index = buildVersionIndex(list);

  return list.map((post) => {
    const entry = index.get(post.slug);
    if (!entry || entry.isLatest) {
      return { ...post, isLatestVersion: true, supersededBy: "", supersededByTitle: "" };
    }
    return {
      ...post,
      isLatestVersion: false,
      supersededBy: entry.latestSlug,
      supersededByTitle: entry.latestTitle,
    };
  });
};

/** Keeps one edition per family. Untagged posts always survive. */
export const selectLatestVersions = (posts) => {
  const index = buildVersionIndex(Array.isArray(posts) ? posts.filter(Boolean) : []);
  return (Array.isArray(posts) ? posts.filter(Boolean) : []).filter(
    (post) => index.get(post.slug)?.isLatest !== false,
  );
};
