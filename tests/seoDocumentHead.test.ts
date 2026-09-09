import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALIAS_REDIRECTS,
  injectIntoTemplate,
  isNoindexPath,
  renderHeadHtml,
  resolveHead,
} from "../api/seo/documentHead.js";
import { STATIC_COMMUNITY_POSTS } from "../api/community/staticPosts.generated.js";

const repoRoot = join(__dirname, "..");
const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const posts = STATIC_COMMUNITY_POSTS as Array<{ slug: string; accessLevel: string }>;
const aPublicPost = posts.find((post) => post.accessLevel === "Public")!;
const anNdaPost = posts.find((post) => post.accessLevel === "NDA")!;

/**
 * Every URL used to return the same shell: one static title, no description, no canonical, no
 * structured data, and an empty root div. A crawler that does not run JavaScript — which is most
 * answer engine fetchers and every social unfurler — saw nothing at all.
 */
describe("per-route document head", () => {
  it("describes the homepage and includes WebSite schema", () => {
    const head = resolveHead("/")!;
    expect(head.title).toContain("HushhTech");
    expect(head.canonical).toBe("https://hushhtech.com/");
    expect(JSON.stringify(head.jsonLd)).toContain("WebSite");
  });

  it("gives a static page its own title and canonical", () => {
    const head = resolveHead("/faq")!;
    expect(head.title).toBe("Frequently asked questions — HushhTech");
    expect(head.canonical).toBe("https://hushhtech.com/faq");
    expect(head.description.length).toBeGreaterThan(30);
  });

  it("treats a trailing slash as the same document", () => {
    expect(resolveHead("/faq/")!.canonical).toBe(resolveHead("/faq")!.canonical);
  });

  it("describes a public community post with Article and Breadcrumb schema", () => {
    const head = resolveHead(`/community/${aPublicPost.slug}`)!;
    expect(head.canonical).toBe(`https://hushhtech.com/community/${aPublicPost.slug}`);
    expect(head.type).toBe("article");
    const schema = JSON.stringify(head.jsonLd);
    expect(schema).toContain("Article");
    expect(schema).toContain("BreadcrumbList");
  });

  it("returns nothing for an unknown route, so the shell is sent untouched", () => {
    expect(resolveHead("/community/no-such-post")).toBeNull();
    expect(resolveHead("/not-a-page")).toBeNull();
  });
});

/**
 * The head is rendered for anonymous requests, so it must never describe gated material. NDA
 * posts have to keep resolving as URLs — the gate lives in the API — but they contribute no
 * title, description or summary to the crawler-visible document.
 */
describe("NDA posts stay out of the crawler-visible head", () => {
  it("has an NDA post to check", () => {
    expect(anNdaPost).toBeTruthy();
  });

  it("resolves no head for an NDA post", () => {
    expect(resolveHead(`/community/${anNdaPost.slug}`)).toBeNull();
  });

  it("resolves no head for any NDA post in the snapshot", () => {
    const leaked = posts
      .filter((post) => post.accessLevel === "NDA")
      .filter((post) => resolveHead(`/community/${post.slug}`) !== null)
      .map((post) => post.slug);
    expect(leaked).toEqual([]);
  });
});

describe("noindex routes", () => {
  it("covers authenticated and admin surfaces", () => {
    for (const path of [
      "/onboarding/step-1",
      "/fund-admin",
      "/nda-admin",
      "/my-documents",
      "/hushh-user-profile",
      "/profile/abc",
      "/metrics",
      "/login",
    ]) {
      expect(isNoindexPath(path), path).toBe(true);
    }
  });

  it("leaves public pages indexable", () => {
    for (const path of ["/", "/community", "/faq", "/about/philosophy", "/discover-fund-a"]) {
      expect(isNoindexPath(path), path).toBe(false);
    }
  });

  it("emits a robots meta tag for a noindex route", () => {
    const head = resolveHead("/fund-admin")!;
    expect(renderHeadHtml(head)).toContain('name="robots"');
  });
});

describe("alias redirects", () => {
  it("maps every duplicate route to one canonical target", () => {
    for (const [from, to] of ALIAS_REDIRECTS) {
      expect(from, `${from} should differ from its target`).not.toBe(to);
      expect(to.startsWith("/"), `${to} should be a path`).toBe(true);
    }
    expect(ALIAS_REDIRECTS.get("/philosophy")).toBe("/about/philosophy");
    expect(ALIAS_REDIRECTS.get("/privacy")).toBe("/privacy-policy");
  });
});

describe("template injection", () => {
  const template =
    '<html><head><meta charset="UTF-8" /><title>Hushh Technologies</title></head>' +
    '<body><div id="root"></div></body></html>';

  it("replaces the static title rather than emitting two", () => {
    const html = injectIntoTemplate(template, resolveHead("/faq")!);
    expect(html.match(/<title>/g)?.length).toBe(1);
    expect(html).toContain("Frequently asked questions");
  });

  it("adds canonical, Open Graph and a noscript body", () => {
    const html = injectIntoTemplate(template, resolveHead(`/community/${aPublicPost.slug}`)!);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain("<noscript>");
    expect(html).toContain("<h1>");
    expect(html).toContain('<div id="root"></div>');
  });

  it("escapes markup so a title can never inject tags", () => {
    const html = injectIntoTemplate(template, {
      ...resolveHead("/faq")!,
      title: '</title><script>alert(1)</script>',
      description: 'a "quoted" & <tagged> value',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;quoted&quot;");
  });
});

describe("generated crawl artifacts", () => {
  const robots = read("public/robots.txt");
  const llms = read("public/llms.txt");
  const sitemap = read("public/sitemap.xml");
  const ndaSlugs = posts.filter((post) => post.accessLevel === "NDA").map((post) => post.slug);

  it("robots.txt disallows private surfaces and names the AI crawlers", () => {
    expect(robots).toContain("Disallow: /onboarding/");
    expect(robots).toContain("Disallow: /fund-admin");
    expect(robots).toContain("User-agent: GPTBot");
    expect(robots).toContain("User-agent: ClaudeBot");
    expect(robots).toContain("User-agent: PerplexityBot");
    expect(robots).toContain("Sitemap: https://hushhtech.com/sitemap.xml");
  });

  it("llms.txt indexes public posts and no NDA ones", () => {
    expect(llms).toContain("# HushhTech");
    expect(llms).toContain("https://hushhtech.com/community/");
    const leaked = ndaSlugs.filter((slug) => llms.includes(`/community/${slug})`));
    expect(leaked).toEqual([]);
  });

  it("ships llms.txt to Cloud Run", () => {
    // .gcloudignore excludes *.txt; without an explicit negation the file never reaches the image.
    const gcloudignore = read(".gcloudignore");
    expect(gcloudignore).toContain("!dist/llms.txt");
    expect(gcloudignore.indexOf("*.txt")).toBeLessThan(gcloudignore.indexOf("!dist/llms.txt"));
  });

  it("sitemap has no duplicate URLs", () => {
    // Four concatenated sources previously produced 258 entries for 204 unique URLs.
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs.length).toBe(new Set(locs).size);
  });

  it("sitemap excludes NDA posts and noindex routes", () => {
    const locs = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
    const leaked = ndaSlugs.filter((slug) => locs.has(`https://hushhtech.com/community/${slug}`));
    expect(leaked).toEqual([]);
    const noindexed = [...locs].filter((loc) =>
      isNoindexPath(new URL(loc).pathname),
    );
    expect(noindexed).toEqual([]);
  });
});
