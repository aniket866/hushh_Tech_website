import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { google } from "googleapis";
import { STATIC_COMMUNITY_POSTS } from "./staticPosts.generated.js";
import {
  buildVersionIndex,
  comparePublishedAtDesc,
  selectLatestVersions,
} from "./postVersions.js";
import { executeDataRequest, resolveLegacyUserUuid, verifyFirebaseBearer } from "../shared/gcpDataRuntime.js";

const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  "";

const CONTENT_BACKEND = (process.env.COMMUNITY_CONTENT_BACKEND || "static").trim().toLowerCase();
const COLLECTION = process.env.COMMUNITY_CONTENT_COLLECTION || "community_posts";
const BUCKET = process.env.COMMUNITY_CONTENT_BUCKET || "";
const CACHE_SECONDS = Number.parseInt(process.env.COMMUNITY_CONTENT_CACHE_SECONDS || "300", 10);
const PUBLIC_ACCESS = "Public";
const NDA_ACCESS = "NDA";

const LOCAL_ASSET_ALLOWLIST = new Set(
  STATIC_COMMUNITY_POSTS.map((post) => post.pdfUrl).filter(Boolean).map((pdfUrl) =>
    pdfUrl.replace(/^\/+/, ""),
  ),
);

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const isGcpEnabled = () => CONTENT_BACKEND === "gcp" && Boolean(PROJECT_ID && COLLECTION);

export class CommunityAccessError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "CommunityAccessError";
    this.statusCode = statusCode;
  }
}

export const isCommunityAccessError = (error) =>
  error instanceof CommunityAccessError ||
  (error?.name === "CommunityAccessError" && Number.isInteger(error?.statusCode));

const bearerTokenFromRequest = (req) => {
  const header =
    req?.headers?.authorization ||
    req?.headers?.Authorization ||
    (typeof req?.get === "function" ? req.get("authorization") : "");
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
};

export const requestAccessLevel = (req) => {
  const value = String(req?.query?.accessLevel || req?.query?.access || "").toLowerCase();
  return value === "nda" || value === "sensitive" ? NDA_ACCESS : PUBLIC_ACCESS;
};

export const assertNdaAccess = async (req) => {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    throw new CommunityAccessError(401, "NDA access requires sign-in");
  }

  let actor;
  try {
    actor = await verifyFirebaseBearer(`Bearer ${token}`);
  } catch {
    throw new CommunityAccessError(401, "Invalid or expired session");
  }
  let legacyUserId;
  try {
    legacyUserId = await resolveLegacyUserUuid(actor.uid);
  } catch {
    throw new CommunityAccessError(503, "NDA status could not be verified");
  }
  if (!legacyUserId) {
    throw new CommunityAccessError(403, "Signed NDA required");
  }
  let rows;
  try {
    ({ data: rows } = await executeDataRequest({
      kind: "table",
      table: "nda_signatures",
      operation: "select",
      columns: "signed_at",
      filters: [{ operator: "eq", column: "user_id", value: legacyUserId }],
      limit: 1,
      cardinality: "many",
    }, actor.uid));
  } catch {
    throw new CommunityAccessError(503, "NDA status could not be verified");
  }
  if (!Array.isArray(rows) || !rows.some((row) => Boolean(row?.signed_at))) {
    throw new CommunityAccessError(403, "Signed NDA required");
  }

  return { userId: actor.uid };
};

const fieldValue = (field) => {
  if (!field) return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number.parseInt(field.integerValue, 10);
  if ("doubleValue" in field) return Number(field.doubleValue);
  if ("booleanValue" in field) return Boolean(field.booleanValue);
  if ("timestampValue" in field) return field.timestampValue;
  if ("arrayValue" in field) {
    return (field.arrayValue.values || []).map(fieldValue);
  }
  if ("mapValue" in field) {
    return Object.fromEntries(
      Object.entries(field.mapValue.fields || {}).map(([key, value]) => [key, fieldValue(value)]),
    );
  }
  return undefined;
};

const communityAssetUrl = (objectName) =>
  `/api/community/assets/${encodeURIComponent(String(objectName).replace(/^\/+/, "")).replace(/%2F/g, "/")}`;

const mediaTypeFor = (value) => (/\.(mp4|mov|webm)$/i.test(value || "") ? "video" : "image");

const normalizeMediaItems = (items) => {
  if (!Array.isArray(items)) return [];

  return items
    .map((item, index) => {
      const value = typeof item === "string" ? { object: item } : item || {};
      const objectName = value.object || value.assetObject || "";
      const suppliedUrl = typeof value.url === "string" ? value.url : "";
      const url = objectName
        ? communityAssetUrl(objectName)
        : suppliedUrl.startsWith("/api/community/assets/")
          ? suppliedUrl
          : "";

      if (!url) return null;

      return {
        name: value.name || objectName.split("/").pop() || `media-${index + 1}`,
        url,
        type: value.type || mediaTypeFor(objectName || url),
        alt: value.alt || "",
      };
    })
    .filter(Boolean);
};

const firestoreDocToPost = (doc) => {
  const fields = doc.fields || {};
  return normalizePost({
    slug: fieldValue(fields.slug) || doc.name?.split("/").pop(),
    title: fieldValue(fields.title),
    publishedAt: fieldValue(fields.publishedAt),
    description: fieldValue(fields.description),
    category: fieldValue(fields.category),
    accessLevel: fieldValue(fields.accessLevel) || "",
    status: fieldValue(fields.status) || "published",
    sourceKind: fieldValue(fields.sourceKind) || "article",
    bodyMarkdown: fieldValue(fields.bodyMarkdown),
    bodyHtml: fieldValue(fields.bodyHtml),
    contentObject: fieldValue(fields.contentObject),
    cardsObject: fieldValue(fields.cardsObject),
    readingMinutes: fieldValue(fields.readingMinutes),
    cardCount: fieldValue(fields.cardCount),
    assetObject: fieldValue(fields.assetObject),
    assetUrl: fieldValue(fields.assetUrl),
    mediaItems: fieldValue(fields.mediaItems),
    docFamily: fieldValue(fields.docFamily),
    docVersion: fieldValue(fields.docVersion),
    supersedes: fieldValue(fields.supersedes),
  });
};

export const normalizePost = (post) => {
  const sourceKind = post.sourceKind || (post.pdfUrl ? "document" : "legacy");
  const assetUrl =
    post.assetUrl ||
    (post.pdfUrl ? `/api/community/assets/public/${encodeURIComponent(post.pdfUrl.replace(/^\/+/, ""))}` : "");

  return {
    id: post.slug,
    slug: post.slug,
    title: post.title,
    date: post.publishedAt || post.date,
    publishedAt: post.publishedAt || post.date,
    description: post.description || "",
    category: post.category || "general",
    accessLevel: post.accessLevel || "",
    status: post.status || "published",
    sourceKind,
    componentName: post.componentName || "",
    contentObject: post.contentObject || "",
    cardsObject: post.cardsObject || "",
    // Precomputed at snapshot time; the list response strips bodies, so nothing downstream can
    // work these out for itself.
    readingMinutes: Number(post.readingMinutes) || 0,
    cardCount: Number(post.cardCount) || 0,
    assetObject: post.assetObject || "",
    assetUrl,
    mediaItems: normalizeMediaItems(post.mediaItems),
    bodyMarkdown: post.bodyMarkdown || "",
    bodyHtml: post.bodyHtml || "",
    // Version identity. Absent on untagged posts, which are then their own family
    // and always survive selectLatestVersions.
    docFamily: post.docFamily || "",
    docVersion: Number.isFinite(Number(post.docVersion)) ? Number(post.docVersion) : 0,
    supersedes: Array.isArray(post.supersedes) ? post.supersedes : [],
  };
};

const publishedWithAccess = (accessLevel) => (post) =>
  post.accessLevel === accessLevel && post.status !== "draft";
const publicPublished = publishedWithAccess(PUBLIC_ACCESS);
const ndaPublished = publishedWithAccess(NDA_ACCESS);

// Version selection runs before the access filter so an NDA-era edition can still
// supersede a public one (and vice versa) instead of both surfacing side by side.
export const staticPosts = (accessLevel = PUBLIC_ACCESS) =>
  selectLatestVersions(STATIC_COMMUNITY_POSTS.map(normalizePost))
    .filter(accessLevel === NDA_ACCESS ? ndaPublished : publicPublished)
    .sort(comparePublishedAtDesc);

const allStaticPosts = () => STATIC_COMMUNITY_POSTS.map(normalizePost);

const getAuthHeaders = async () => {
  const client = await auth.getClient();
  return client.getRequestHeaders();
};

const fetchJson = async (url) => {
  const headers = await getAuthHeaders();
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GCP content request failed with HTTP ${response.status}`);
  }
  return response.json();
};

/**
 * A deck or article body, from the bucket, falling back to the committed copy.
 *
 * The generated snapshot no longer inlines deck prose — the same markdown is in GCS and in
 * `content/decks/text/`, and duplicating 843 KB of it into a module the runtime parses on every
 * cold start bought nothing. `withDetailContent` hydrates through here instead, so this is now the
 * only path to a public deck's text and it has to survive a bucket that is unset or unreachable.
 * Returning "" there would hand a crawler an empty document.
 *
 * Gated objects are never served from disk: `localDeckFile` matches the public `decks/` prefix
 * only, and the gated directories are not in this repository.
 */
const fetchGcsText = async (objectName) => {
  if (!objectName) return "";
  const localDeck = localDeckFile(objectName);
  const fromDisk = () => (localDeck ? readFileSync(localDeck.path, "utf8") : "");

  if (!BUCKET) return fromDisk();

  const encodedObject = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodedObject}?alt=media`;
  try {
    const response = await fetch(url, { headers: await getAuthHeaders() });
    if (!response.ok) return fromDisk();
    return response.text();
  } catch (error) {
    if (localDeck) {
      console.warn(`[community] reading ${objectName} from the committed copy: ${error.message}`);
      return fromDisk();
    }
    throw error;
  }
};

/**
 * The fields a list response is built from. Bodies are deliberately absent: api/community/posts.js
 * strips bodyMarkdown and bodyHtml before responding, so fetching them was pure waste — roughly
 * 430 KB of deck and article text read from Firestore and thrown away on every list request.
 */
const LIST_FIELD_MASK = [
  "slug",
  "title",
  "publishedAt",
  "description",
  "category",
  "accessLevel",
  "status",
  "sourceKind",
  "componentName",
  "contentObject",
  "cardsObject",
  "readingMinutes",
  "cardCount",
  "assetObject",
  "assetUrl",
  "pdfUrl",
  "mediaItems",
  "docFamily",
  "docVersion",
  "supersedes",
];

/**
 * Reads the whole collection.
 *
 * Firestore's document list returns at most 100 documents per page. Both callers below used to
 * issue one unpaginated GET and treat the result as the collection, so once `community_posts` grew
 * past 100 documents the community index silently served whichever 100 sorted first by document
 * id — 90 public posts out of 130, and the missing 40 were invisible with no error anywhere. The
 * page size is now explicit and the page token is followed to the end.
 *
 * The page cap is a guard against a pathological token loop, not a content limit; it is an order
 * of magnitude above the collection and logs rather than truncating silently.
 */
const listAllDocuments = async (fieldPaths = LIST_FIELD_MASK) => {
  const documents = [];
  let pageToken;
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}`,
    );
    url.searchParams.set("pageSize", "300");
    for (const path of fieldPaths) url.searchParams.append("mask.fieldPaths", path);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await fetchJson(url.toString());
    documents.push(...(data.documents || []));
    pageToken = data.nextPageToken;
    if (!pageToken) return documents;
  }
  console.error(`[community] stopped paging ${COLLECTION} after 50 pages; the collection may be truncated`);
  return documents;
};

const listGcpPosts = async (accessLevel) => {
  const documents = await listAllDocuments();
  return selectLatestVersions(documents.map(firestoreDocToPost))
    .filter(accessLevel === NDA_ACCESS ? ndaPublished : publicPublished)
    .sort(comparePublishedAtDesc);
};

/**
 * Resolves the current edition of a post's family for the detail route.
 *
 * Only runs when the post declares a docFamily, so the common untagged case pays
 * nothing; a tagged post costs one list read to learn where it forwards to.
 */
const resolveSupersededBy = async (post) => {
  if (!post?.docFamily) return { ...post, isLatestVersion: true, supersededBy: "", supersededByTitle: "" };

  let family = allStaticPosts();
  if (isGcpEnabled()) {
    try {
      const documents = (await listAllDocuments()).map(firestoreDocToPost);
      if (documents.length) family = documents;
    } catch (error) {
      console.error("[community] Version lookup fell back to the static snapshot:", error.message);
    }
  }

  // The post itself may be newer than the snapshot, so fold it in before indexing.
  const entry = buildVersionIndex([...family.filter((item) => item.slug !== post.slug), post]).get(post.slug);
  if (!entry || entry.isLatest) {
    return { ...post, isLatestVersion: true, supersededBy: "", supersededByTitle: "" };
  }
  return {
    ...post,
    isLatestVersion: false,
    supersededBy: entry.latestSlug,
    supersededByTitle: entry.latestTitle,
  };
};

const withDetailContent = async (post) => {
  if (!post.bodyMarkdown && post.contentObject) {
    post.bodyMarkdown = await fetchGcsText(post.contentObject);
  }
  if (!post.assetUrl && post.assetObject) {
    post.assetUrl = `/api/community/assets/${encodeURIComponent(post.assetObject).replace(/%2F/g, "/")}`;
  }
  return post;
};

const authorizePost = async (post, req) => {
  if (publicPublished(post)) return post;
  if (ndaPublished(post)) {
    await assertNdaAccess(req);
    return post;
  }
  return null;
};

export const listCommunityPosts = async (req) => {
  const accessLevel = requestAccessLevel(req);
  if (accessLevel === NDA_ACCESS) {
    await assertNdaAccess(req);
  }

  if (!isGcpEnabled()) return staticPosts(accessLevel);

  try {
    const posts = await listGcpPosts(accessLevel);

    return posts.length ? posts : staticPosts(accessLevel);
  } catch (error) {
    if (isCommunityAccessError(error)) throw error;
    console.error("[community] Falling back to static post snapshot:", error.message);
    return staticPosts(accessLevel);
  }
};

export const getCommunityPost = async (slug, req) => {
  if (!slug) return null;

  if (isGcpEnabled()) {
    try {
      const encodedSlug = encodeURIComponent(slug).replace(/%2F/g, "%2F");
      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${encodedSlug}`;
      const data = await fetchJson(url);
      const post = firestoreDocToPost(data);
      const authorizedPost = await authorizePost(post, req);

      if (!authorizedPost) return null;
      return withDetailContent(await resolveSupersededBy(authorizedPost));
    } catch (error) {
      if (isCommunityAccessError(error)) throw error;
      console.error("[community] Falling back to static post detail:", error.message);
    }
  }

  // Superseded editions resolve here on purpose: their URLs keep working, and the
  // response carries supersededBy so the page can canonical forward.
  const post = allStaticPosts().find((item) => item.slug === slug);
  if (!post) return null;
  const authorizedPost = await authorizePost(post, req);
  return authorizedPost ? withDetailContent(await resolveSupersededBy(authorizedPost)) : null;
};

export const setCommunityCacheHeaders = (res, options = {}) => {
  if (options.privateContent) {
    res.setHeader("Cache-Control", "private, no-store");
    return;
  }
  const maxAge = Number.isFinite(CACHE_SECONDS) && CACHE_SECONDS >= 0 ? CACHE_SECONDS : 300;
  res.setHeader("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`);
};

const isNdaAsset = (objectName) =>
  /^(gated|nda|private|sensitive)\//i.test(objectName || "");

/**
 * The committed copy of a public deck body, if there is one on disk.
 *
 * `content/decks/` is the exact source `publish-deck-content.mjs` uploads from, so the bytes are
 * the same. Falling back to it is what makes the static content backend an actual fallback:
 * without it, a bucket that is unreachable — a GCS incident, or any environment with no GCP
 * credentials — renders every deck as "the reading view could not be loaded" while the text sits
 * unused inside the image.
 *
 * Gated decks are deliberately excluded. `content/decks/{cards,text}-gated` are gitignored, so
 * there is nothing on disk to serve; the explicit guard keeps that true if that ever changes.
 * The slug pattern also confines the lookup to two known directories — no traversal is expressible.
 */
const localDeckFile = (objectName) => {
  const match = /^decks\/([a-z0-9][a-z0-9-]*)\/(cards\.json|index\.md)$/.exec(objectName);
  if (!match) return null;
  const [, assetName, fileName] = match;
  const isCards = fileName === "cards.json";
  const path = join(
    process.cwd(),
    isCards ? "content/decks/cards" : "content/decks/text",
    `${assetName}${isCards ? ".json" : ".md"}`,
  );
  if (!existsSync(path)) return null;
  return { path, contentType: isCards ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8" };
};

const serveLocalDeckFile = (res, file) => {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Cache-Control", "public, max-age=3600");
  createReadStream(file.path).pipe(res);
};

export const streamCommunityAsset = async (req, res) => {
  const rawObject = req.params?.[0] || req.params?.object || "";
  const objectName = decodeURIComponent(rawObject).replace(/^\/+/, "");

  if (objectName.startsWith("public/")) {
    const fileName = objectName.slice("public/".length);
    if (!LOCAL_ASSET_ALLOWLIST.has(fileName)) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const distPath = join(process.cwd(), "dist", fileName);
    const publicPath = join(process.cwd(), "public", fileName);
    const filePath = existsSync(distPath) ? distPath : publicPath;
    const normalized = normalize(filePath);
    if (!existsSync(normalized)) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    res.setHeader("Content-Type", extname(fileName).toLowerCase() === ".pdf" ? "application/pdf" : "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    createReadStream(normalized).pipe(res);
    return;
  }

  const privateAsset = isNdaAsset(objectName);
  const localDeck = privateAsset ? null : localDeckFile(objectName);

  if (!BUCKET || !objectName) {
    if (localDeck) {
      serveLocalDeckFile(res, localDeck);
      return;
    }
    res.status(404).json({ error: "Asset not configured" });
    return;
  }

  if (privateAsset) {
    await assertNdaAccess(req);
  }

  const encodedObject = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodedObject}?alt=media`;
  // Minting a token and reaching the bucket both throw rather than return a status, and either is
  // exactly the outage the committed copy exists for — so the whole upstream attempt is guarded.
  let upstream;
  try {
    upstream = await fetch(url, { headers: await getAuthHeaders() });
  } catch (error) {
    if (localDeck) {
      console.warn(`[community] serving ${objectName} from the committed copy: ${error.message}`);
      serveLocalDeckFile(res, localDeck);
      return;
    }
    throw error;
  }
  if (!upstream.ok || !upstream.body) {
    if (localDeck) {
      serveLocalDeckFile(res, localDeck);
      return;
    }
    res.status(upstream.status).json({ error: "Asset not found" });
    return;
  }

  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  // Card imagery is content-addressed — mirror-deck-images.mjs names each file by the sha256 of
  // its bytes — so the URL can never point at different content and the response is safe to hold
  // forever. Everything else keeps the conservative hour, and a gated asset is never stored.
  const immutable = !privateAsset && /\/media\/[0-9a-f]{16}\.(?:jpg|png)$/.test(objectName);
  res.setHeader(
    "Cache-Control",
    privateAsset
      ? "private, no-store"
      : immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
  );
  // Lets a repeat visitor revalidate with a 304 instead of re-downloading a 200 KB image once the
  // hour is up. GCS supplies both; neither was being passed through.
  for (const header of ["etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  const reader = upstream.body.getReader();
  const pump = async () => {
    const { done, value } = await reader.read();
    if (done) {
      res.end();
      return;
    }
    res.write(Buffer.from(value));
    await pump();
  };
  await pump();
};
