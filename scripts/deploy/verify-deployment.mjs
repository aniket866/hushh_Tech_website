#!/usr/bin/env node
/**
 * Smoke-tests a deployed Hushh Tech host from the outside.
 *
 * The repo's existing gates check artifacts: the snapshot, the sitemap, the NDA gate's source.
 * This checks the thing users and crawlers actually get. It exists because two of the defects this
 * branch fixed were invisible to every artifact check — a document head that was identical on every
 * URL, and a Firestore list silently truncated to its first page — and both were obvious the moment
 * anyone looked at a response.
 *
 * Usage:
 *   node scripts/deploy/verify-deployment.mjs                                  # UAT
 *   node scripts/deploy/verify-deployment.mjs --host https://hushhtech.com     # after a promotion
 *   node scripts/deploy/verify-deployment.mjs --expect-commit <sha>
 *
 * Exits non-zero on the first failed expectation, so it works as a deploy gate.
 */

const parseArgs = () => {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
};

const args = parseArgs();
const HOST = (typeof args.host === "string" ? args.host : "https://uat.hushhtech.com").replace(/\/$/, "");
// Answer engines are the point of the head work, so ask as one.
const CRAWLER_UA = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

/** One route per head shape: home, a static page, an index, a nested static page. */
const STATIC_ROUTE_SAMPLE = ["/", "/faq", "/community", "/about/philosophy"];

const results = [];
const check = async (name, run) => {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`  FAIL  ${name} — ${error.message}`);
  }
};

const expect = (condition, message) => { if (!condition) throw new Error(message); };

const get = (path, init = {}) =>
  fetch(`${HOST}${path}`, { redirect: "manual", headers: { "User-Agent": CRAWLER_UA, ...(init.headers || {}) }, ...init });

const titleOf = (html) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";

const main = async () => {
  console.log(`verifying ${HOST}\n`);

  await check("release identity", async () => {
    const release = await (await get("/api/release")).json();
    expect(release.status === "ok", `status ${release.status}`);
    if (typeof args["expect-commit"] === "string") {
      expect(release.commit_sha === args["expect-commit"], `serving ${release.commit_sha}`);
    }
    return `${release.revision} @ ${(release.commit_sha || "").slice(0, 8)}`;
  });

  // --- content -------------------------------------------------------------------------------
  let posts = [];
  await check("public post list", async () => {
    const body = await (await get("/api/community/posts")).json();
    posts = body.posts || [];
    expect(posts.length >= 120, `only ${posts.length} posts`);
    return `${posts.length} posts, newest ${posts[0]?.publishedAt}`;
  });

  await check("no NDA post in the public list", async () => {
    const leaked = posts.filter((post) => post.accessLevel === "NDA").map((post) => post.slug);
    expect(leaked.length === 0, `leaked ${leaked.join(", ")}`);
    return "0 of them NDA";
  });

  await check("one edition per document family", async () => {
    const families = new Map();
    for (const post of posts.filter((entry) => entry.docFamily)) {
      families.set(post.docFamily, [...(families.get(post.docFamily) || []), post.slug]);
    }
    const duplicated = [...families.entries()].filter(([, slugs]) => slugs.length > 1);
    expect(duplicated.length === 0, `${duplicated.length} family/families listed twice`);
    // Zero families would pass the duplicate test vacuously — and would mean version identity
    // never reached the datastore, which is the failure this check exists to catch.
    expect(families.size > 0, "no post carries a docFamily; version identity did not reach the API");
    return `${families.size} families, one edition each`;
  });

  await check("decks are published", async () => {
    const decks = posts.filter((post) => post.sourceKind === "deck");
    expect(decks.length >= 15, `only ${decks.length} decks`);
    return `${decks.length} decks in the public list`;
  });

  await check("an anonymous NDA list is refused", async () => {
    const response = await get("/api/community/posts?accessLevel=nda");
    expect([401, 403].includes(response.status), `HTTP ${response.status} — NDA list served anonymously`);
    return `HTTP ${response.status}`;
  });

  await check("an anonymous NDA detail is refused", async () => {
    // A deck, because those are the posts this branch published; the slug is public, the body is not.
    // 404 counts: the requirement is that the body is not served, and a 404 additionally declines to
    // confirm the post exists. What must never appear is a 200.
    const response = await get("/api/community/posts/general/the-simons-code?accessLevel=nda");
    expect([401, 403, 404].includes(response.status), `HTTP ${response.status} — NDA detail served anonymously`);
    return `HTTP ${response.status}`;
  });

  // --- assets --------------------------------------------------------------------------------
  await check("a public deck asset serves", async () => {
    const deck = posts.find((post) => post.sourceKind === "deck" && post.contentObject?.startsWith("decks/"))
      || posts.find((post) => post.sourceKind === "deck");
    expect(Boolean(deck?.cardsObject), "no public deck exposes a cardsObject");
    const cardsResponse = await get(`/api/community/assets/${deck.cardsObject}`);
    expect(cardsResponse.status === 200, `HTTP ${cardsResponse.status} for ${deck.cardsObject}`);
    const cardsDocument = await cardsResponse.json();
    const imagePath = cardsDocument.cards
      ?.flatMap((card) => card.images || [])
      .find((value) => value.startsWith("/api/community/assets/decks/"));
    expect(Boolean(imagePath), `no mirrored public image found for ${deck.slug}`);
    const imageUrl = new URL(imagePath, HOST);
    const response = await get(`${imageUrl.pathname}${imageUrl.search}`);
    expect(response.status === 200, `HTTP ${response.status} for ${imagePath}`);

    // A 200 is not enough. server.js sends `X-Content-Type-Options: nosniff` on every response,
    // so an image served as application/octet-stream is refused by the browser and the deck
    // renders with broken images — while curl, an uptime check and this very check all see a
    // perfectly healthy 200. That is not hypothetical: 1296 objects reached the production bucket
    // with no contentType at all (a GCS rewrite whose metadata body omits it drops it), and this
    // check passed the whole time because it only printed the header instead of asserting it.
    const contentType = response.headers.get("content-type") || "";
    expect(
      contentType.startsWith("image/"),
      `${imagePath} served as "${contentType}" — nosniff means the browser will not render it`,
    );
    return `${deck.slug} ${imagePath.split("/").pop()} ${contentType}`;
  });

  await check("a gated deck page is refused", async () => {
    const response = await get("/api/community/assets/gated/decks/the-simons-code/pages/page-001.jpg");
    expect([401, 403, 404].includes(response.status), `HTTP ${response.status} — gated asset served anonymously`);
    return `HTTP ${response.status}`;
  });

  await check("gated assets are never cached", async () => {
    const response = await get("/api/community/assets/gated/decks/the-simons-code/pages/page-001.jpg");
    const cacheControl = response.headers.get("cache-control") || "";
    expect(!/public|max-age=[1-9]/.test(cacheControl), `Cache-Control: ${cacheControl}`);
    return cacheControl || "(none)";
  });

  await check("a deck serves its reading cards", async () => {
    const deck = posts.find((post) => post.sourceKind === "deck" && post.cardsObject);
    expect(Boolean(deck), "no public deck exposes a cardsObject");
    const response = await get(`/api/community/assets/${deck.cardsObject}`);
    expect(response.status === 200, `HTTP ${response.status} for ${deck.cardsObject}`);
    const document = await response.json();
    expect(Array.isArray(document.cards) && document.cards.length > 0, "cards.json has no cards");
    expect(document.cards.every((card) => card.title), "some cards have no title");
    const images = document.cards.flatMap((card) => card.images || []);
    const foreign = images.filter((src) => !src.startsWith("/api/community/assets/"));
    expect(foreign.length === 0, `${foreign.length} card image(s) still point at an external CDN`);
    return `${deck.slug}: ${document.cards.length} cards, ${images.length} self-hosted images`;
  });

  await check("a gated deck's cards are refused", async () => {
    const response = await get("/api/community/assets/gated/decks/the-simons-code/cards.json");
    expect([401, 403, 404].includes(response.status), `HTTP ${response.status} — gated cards served anonymously`);
    return `HTTP ${response.status}`;
  });

  // --- crawler-visible head ------------------------------------------------------------------
  const titles = new Map();
  for (const path of STATIC_ROUTE_SAMPLE) {
    await check(`head for ${path}`, async () => {
      const html = await (await get(path)).text();
      const title = titleOf(html);
      expect(title.length > 0, "no <title>");
      expect((html.match(/<title>/g) || []).length === 1, "more than one <title>");
      expect(html.includes('rel="canonical"'), "no canonical");
      expect(html.includes('property="og:title"'), "no Open Graph");
      titles.set(path, title);
      return title;
    });
  }

  await check("each route has its own title", async () => {
    // Guard against passing because every head check above failed and left this map empty.
    expect(titles.size === STATIC_ROUTE_SAMPLE.length, `only ${titles.size} routes produced a title`);
    const unique = new Set(titles.values());
    expect(unique.size === titles.size, `${titles.size} routes share ${unique.size} title(s)`);
    return `${unique.size} distinct titles`;
  });

  await check("a post renders for a crawler that runs no JavaScript", async () => {
    const post = posts.find((entry) => entry.accessLevel === "Public");
    const html = await (await get(`/community/${post.slug}`)).text();
    expect(titleOf(html).length > 0, "no <title>");
    expect(html.includes("<noscript>"), "no noscript body");
    expect(/"@type"\s*:\s*"(Article|BlogPosting)"/.test(html), "no Article schema");
    return post.slug;
  });

  await check("a deck gives a crawler the whole document", async () => {
    // The page this replaced delivered 33 characters of body text, because its content lived in an
    // iframe. A deck's own words have to be on the page or publishing it achieves nothing.
    const deck = posts.find((post) => post.sourceKind === "deck" && post.cardsObject);
    expect(Boolean(deck), "no public deck exposes a cardsObject");
    const html = await (await get(`/community/${deck.slug}`)).text();
    const body = html.split("</head>")[1] || "";
    const text = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.length > 20000, `only ${text.length} chars of body text`);
    expect(/<h2[\s>]/.test(body), "no headings in the crawler-visible body");
    return `${deck.slug}: ${text.length} chars`;
  });

  await check("a gated deck gives a crawler nothing", async () => {
    const html = await (await get("/community/general/the-simons-code")).text();
    const body = html.split("</head>")[1] || "";
    const text = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.length === 0, `${text.length} chars of NDA deck text reached the shell`);
    return "0 chars";
  });

  // --- crawl control -------------------------------------------------------------------------
  await check("robots.txt", async () => {
    const body = await (await get("/robots.txt")).text();
    expect(body.includes("Disallow: /fund-admin"), "admin surfaces not disallowed");
    expect(body.includes("Sitemap:"), "no sitemap reference");
    return `${body.split("\n").length} lines`;
  });

  await check("llms.txt", async () => {
    const response = await get("/llms.txt");
    expect(response.status === 200, `HTTP ${response.status}`);
    const body = await response.text();
    expect(body.startsWith("# "), "not an llms.txt document");
    return `${(body.match(/^- /gm) || []).length} indexed entries`;
  });

  await check("sitemap.xml lists no NDA post", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    const locations = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
    const leaked = posts.filter((post) => post.accessLevel === "NDA")
      .filter((post) => locations.has(`https://hushhtech.com/community/${post.slug}`));
    expect(leaked.length === 0, `${leaked.length} NDA URLs submitted to search engines`);
    return `${locations.size} URLs, none NDA`;
  });

  await check("a noindex route says so in its headers", async () => {
    const response = await get("/fund-admin");
    expect((response.headers.get("x-robots-tag") || "").includes("noindex"), "no X-Robots-Tag");
    return response.headers.get("x-robots-tag");
  });

  await check("an unknown post is a 404, not a soft 404", async () => {
    const response = await get("/community/general/definitely-not-a-post");
    expect(response.status === 404, `HTTP ${response.status}`);
    return "404";
  });

  await check("a duplicate route redirects to its canonical", async () => {
    const response = await get("/philosophy");
    expect(response.status === 301, `HTTP ${response.status}`);
    return `301 → ${response.headers.get("location")}`;
  });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
};

main().catch((error) => { console.error(error); process.exit(1); });
