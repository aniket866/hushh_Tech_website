/**
 * Per-route document head for the SPA shell.
 *
 * Every URL on the site used to return the same HTML: `<title>Hushh Technologies</title>`, no
 * description, no canonical, no Open Graph, no JSON-LD, and an empty `<div id="root">`. A crawler
 * that runs JavaScript could eventually see the page; one that does not — which is most answer
 * engine fetchers, and every social unfurler — saw nothing. The whole community library was
 * invisible to them.
 *
 * This module builds a real head, and a `<noscript>` block carrying the page's heading and text,
 * which server.js splices into the built index.html before sending it. It is a cached string
 * replace, not server-side rendering: no React runs, the SPA hydrates exactly as before, and the
 * cost is a map lookup per request.
 *
 * Post metadata comes from the committed snapshot rather than Firestore so a page view costs no
 * network round trip. The snapshot only ever contains published posts, and this module filters to
 * Public, so NDA material cannot reach the head of a page served to an anonymous visitor.
 */

import { staticPosts } from "../community/content-service.js";
import { comparePublishedAtDesc } from "../community/postVersions.js";

export const SITE_URL = "https://hushhtech.com";
export const SITE_NAME = "HushhTech";

const DEFAULT_TITLE = "HushhTech — The AI-powered Berkshire Hathaway";
const DEFAULT_DESCRIPTION =
  "HushhTech combines AI and human expertise to invest in exceptional businesses for " +
  "long-term value creation — the AI-powered Berkshire Hathaway.";
const DEFAULT_IMAGE = `${SITE_URL}/og-default.png`;

/**
 * Routes that should never be indexed: authenticated flows, admin surfaces and anything showing
 * one person's data. robots.txt disallows them too; this adds the header and meta tag so a page
 * that is linked from elsewhere still says no.
 */
export const NOINDEX_PREFIXES = [
  "/onboarding",
  "/hushh-user-profile",
  "/profile",
  "/hushhid",
  "/fund-admin",
  "/nda-admin",
  "/my-documents",
  "/document-viewer",
  "/sign-nda",
  "/reports",
  "/deployments",
  "/metric",
  "/metrics",
  "/login",
  "/signup",
  "/signed-out",
  "/auth",
  "/receipt-generator",
  "/delete-account",
];

/**
 * Duplicate routes App.tsx registers as aliases. They served 200 with the homepage canonical,
 * which asks search engines to index several URLs for one page.
 */
export const ALIAS_REDIRECTS = new Map([
  ["/philosophy", "/about/philosophy"],
  ["/privacy", "/privacy-policy"],
  ["/terms", "/terms-of-service"],
  ["/disclosures", "/risk-disclosures"],
  ["/careers", "/career"],
  ["/Login", "/login"],
  ["/Contact", "/contact"],
  ["/Signup", "/signup"],
]);

/** Public marketing and legal pages, none of which set their own title before this. */
export const STATIC_ROUTES = new Map([
  ["/", { title: "", description: DEFAULT_DESCRIPTION }],
  [
    "/community",
    {
      title: "Community",
      description:
        "Research, fund updates, market commentary and investor letters from HushhTech — " +
        "the thinking behind an AI-first approach to owning exceptional businesses.",
    },
  ],
  [
    "/discover-fund-a",
    {
      title: "Fund A — AI-powered value investing",
      description:
        "Fund A applies AI to the discipline of long-term business ownership: free-cash-flow " +
        "compounders, held for decades, at the lowest possible cost.",
    },
  ],
  [
    "/about/philosophy",
    {
      title: "Philosophy",
      description:
        "Simplicity, humility and cost-efficiency as investment principles — how HushhTech " +
        "thinks about owning great businesses for the long run.",
    },
  ],
  [
    "/about/leadership",
    {
      title: "Leadership",
      description: "The people building HushhTech, and the experience they bring to it.",
    },
  ],
  [
    "/faq",
    {
      title: "Frequently asked questions",
      description:
        "Common questions about HushhTech, Fund A, eligibility, fees and how the investment " +
        "process works.",
    },
  ],
  [
    "/career",
    {
      title: "Careers",
      description:
        "Build the AI-first investment firm. Open roles, how we work, and what we look for.",
    },
  ],
  [
    "/benefits",
    {
      title: "Benefits",
      description: "How HushhTech supports the people who work here.",
    },
  ],
  [
    "/contact",
    {
      title: "Contact",
      description: "Get in touch with the HushhTech team.",
    },
  ],
  [
    "/support",
    {
      title: "Support",
      description: "Help with your HushhTech account, documents and investor onboarding.",
    },
  ],
  [
    "/sell-the-wall",
    {
      title: "Sell the Wall",
      description:
        "A systematic approach to capturing alpha by selling options on exceptional businesses, " +
        "with AI optimising every trade.",
    },
  ],
  [
    "/ai-powered-berkshire",
    {
      title: "The AI-powered Berkshire Hathaway",
      description:
        "What it means to run Berkshire's discipline with an AI-first research and execution stack.",
    },
  ],
  [
    "/privacy-policy",
    { title: "Privacy policy", description: "How HushhTech collects, uses and protects your data." },
  ],
  [
    "/terms-of-service",
    { title: "Terms of service", description: "The terms that govern use of HushhTech services." },
  ],
  [
    "/risk-disclosures",
    {
      title: "Risk disclosures",
      description: "Important risk information for prospective and current HushhTech investors.",
    },
  ],
  [
    "/california-privacy-policy",
    { title: "California privacy policy", description: "Your privacy rights under California law." },
  ],
  [
    "/eu-uk-jobs-privacy-policy",
    {
      title: "EU & UK candidate privacy policy",
      description: "How HushhTech handles candidate data in the EU and UK.",
    },
  ],
]);

export const isNoindexPath = (pathname) =>
  NOINDEX_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The meta description and the JSON-LD abstract: a sentence or two, not the document. */
const SUMMARY_LIMIT = 2000;

/**
 * The crawler-visible body cap.
 *
 * The longest deck on the site is ~100 KB of markdown, so this covers every current document while
 * bounding the response for anything pathological. It is deliberately not 2000: the point of the
 * block is that an answer engine can read the whole piece and cite a specific claim from it, and a
 * 2000-character abstract of a 25,000-word deck is not that.
 */
const BODY_LIMIT = 240_000;

/** What goes into JSON-LD's articleBody. Smaller than the noscript body — see resolveHead. */
const ARTICLE_BODY_LIMIT = 30_000;

/**
 * Markdown to plain prose. Used for the meta description and the JSON-LD abstract, where structure
 * would be noise.
 */
const markdownToText = (markdown) =>
  String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Markdown to the small subset of HTML the noscript body needs: headings, paragraphs, list items
 * and table rows. Structure is the whole point — a document's heading outline is what an answer
 * engine uses to decide which part answers a question, and flattening it to one paragraph throws
 * that away.
 *
 * Everything is escaped, so a body can carry no markup of its own into the page.
 */
const markdownToHtml = (markdown, pageHeading = "") => {
  const source = String(markdown || "")
    .slice(0, BODY_LIMIT)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  const parts = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    parts.push(`<p>${escapeHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const text = heading[2].replace(/[*_`]/g, "").trim();
      // A body's `# ` line is the document's own title, which renderNoscriptHtml has already
      // emitted as the page's <h1>. Repeating it pushed every real section down a level and put
      // the title on the page twice.
      if (heading[1].length === 1) {
        if (!pageHeading || text.toLowerCase() === pageHeading.toLowerCase()) continue;
      }
      const level = Math.min(6, Math.max(2, heading[1].length));
      parts.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
      continue;
    }
    if (/^\|[\s-|:]+\|$/.test(line)) continue; // a table's separator row carries no content
    if (line.startsWith("|")) {
      flush();
      const cells = line.split("|").slice(1, -1).map((cell) => escapeHtml(cell.trim()));
      parts.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      parts.push(`<li>${escapeHtml(line.replace(/^[-*]\s+/, "").replace(/[*_`]/g, ""))}</li>`);
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      parts.push(`<blockquote>${escapeHtml(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    paragraph.push(line.replace(/[*_`]/g, ""));
  }
  flush();

  // Wrap runs of rows and list items so the markup is valid rather than a stream of orphans.
  return parts
    .join("\n")
    .replace(/(?:<tr>[\s\S]*?<\/tr>\n?)+/g, (rows) => `<table><tbody>${rows.trim()}</tbody></table>`)
    .replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (items) => `<ul>${items.trim()}</ul>`);
};

let cachedPosts = null;
const publicPosts = () => {
  if (!cachedPosts) {
    try {
      cachedPosts = staticPosts("Public").slice().sort(comparePublishedAtDesc);
    } catch {
      cachedPosts = [];
    }
  }
  return cachedPosts;
};

/** Exposed so tests can reset between cases. */
export const resetPostCache = () => {
  cachedPosts = null;
};

const websiteSchema = () => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/community?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
});

const breadcrumbSchema = (post) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    { "@type": "ListItem", position: 2, name: "Community", item: `${SITE_URL}/community` },
    { "@type": "ListItem", position: 3, name: post.title, item: `${SITE_URL}/community/${post.slug}` },
  ],
});

const articleSchema = (post, body) => ({
  "@context": "https://schema.org",
  "@type": "Article",
  headline: post.title,
  description: post.description || undefined,
  // schema.org/articleBody. Answer engines read this directly, and unlike the rendered page it
  // needs no JavaScript and no heuristics about which part of the DOM is the article.
  articleBody: body || undefined,
  wordCount: body ? body.split(/\s+/).filter(Boolean).length : undefined,
  datePublished: post.publishedAt || undefined,
  dateModified: post.publishedAt || undefined,
  articleSection: post.category || undefined,
  mainEntityOfPage: `${SITE_URL}/community/${post.slug}`,
  author: { "@type": "Organization", name: "Hushh Technologies LLC", url: SITE_URL },
  publisher: { "@type": "Organization", name: "Hushh Technologies LLC", url: SITE_URL },
});

/**
 * Resolves the head for a path. Returns null for paths with nothing to say, so the caller can
 * send the untouched shell rather than a head full of homepage defaults.
 */
export const resolveHead = (pathname) => {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const noindex = isNoindexPath(clean);

  if (clean.startsWith("/community/")) {
    const slug = clean.slice("/community/".length);
    const post = publicPosts().find((entry) => entry.slug === slug);
    if (!post) return null;

    const summary = markdownToText(post.bodyMarkdown).slice(0, SUMMARY_LIMIT);
    const bodyHtml = markdownToHtml(post.bodyMarkdown, post.title);
    // The plain-text body for schema.org, capped well below the noscript block: JSON-LD is parsed
    // whole by every consumer, so a 100 KB string in it is a cost paid on every request.
    const articleBody = markdownToText(post.bodyMarkdown).slice(0, ARTICLE_BODY_LIMIT) || undefined;
    return {
      title: `${post.title} — ${SITE_NAME}`,
      description: post.description || DEFAULT_DESCRIPTION,
      canonical: `${SITE_URL}/community/${post.slug}`,
      image: DEFAULT_IMAGE,
      type: "article",
      noindex,
      heading: post.title,
      summary,
      bodyHtml,
      jsonLd: [articleSchema(post, articleBody), breadcrumbSchema(post)],
    };
  }

  const route = STATIC_ROUTES.get(clean);
  if (!route && !noindex) return null;

  const title = route?.title ? `${route.title} — ${SITE_NAME}` : DEFAULT_TITLE;
  return {
    title,
    description: route?.description || DEFAULT_DESCRIPTION,
    canonical: `${SITE_URL}${clean === "/" ? "/" : clean}`,
    image: DEFAULT_IMAGE,
    type: "website",
    noindex,
    heading: route?.title || SITE_NAME,
    summary: route?.description || DEFAULT_DESCRIPTION,
    jsonLd: clean === "/" ? [websiteSchema()] : [],
  };
};

/** The tags themselves. react-helmet replaces these client-side once the SPA boots. */
export const renderHeadHtml = (head) => {
  const tags = [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(head.canonical)}" />`,
    head.noindex ? `<meta name="robots" content="noindex,nofollow" />` : "",
    `<meta property="og:type" content="${escapeHtml(head.type)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(head.canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(head.image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(head.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(head.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(head.image)}" />`,
    ...(head.jsonLd || []).map(
      (block) =>
        `<script type="application/ld+json">${JSON.stringify(block).replace(/</g, "\\u003c")}</script>`,
    ),
  ];
  return tags.filter(Boolean).join("\n    ");
};

/**
 * The crawler-visible body. React replaces #root on hydration, so this content is only ever seen
 * by a client that does not run scripts — exactly the audience it is written for.
 */
/**
 * The body a crawler that runs no JavaScript actually receives.
 *
 * `<noscript>` rather than a hidden div on purpose. Google processes noscript content, and it is
 * unambiguously not cloaking: the same words are what a reader sees once the SPA boots. A visually
 * hidden block would carry more weight and would also be indistinguishable from the oldest trick in
 * the book, which is not a trade this site should make.
 */
export const renderNoscriptHtml = (head) => {
  const parts = [`<h1>${escapeHtml(head.heading)}</h1>`];
  if (head.summary) parts.push(`<p>${escapeHtml(head.summary)}</p>`);
  if (head.bodyHtml) parts.push(head.bodyHtml);
  return `<noscript>\n      ${parts.join("\n      ")}\n    </noscript>`;
};

/**
 * Splices the head before </head> and the noscript block after the root div. The built index.html
 * ships a static <title>, so drop it rather than emitting two.
 */
export const injectIntoTemplate = (template, head) => {
  const headHtml = renderHeadHtml(head);
  const noscriptHtml = renderNoscriptHtml(head);

  return template
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace("</head>", `  ${headHtml}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root"></div>\n    ${noscriptHtml}`);
};
