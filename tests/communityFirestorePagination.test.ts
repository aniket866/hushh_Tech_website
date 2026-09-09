import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Firestore's document list returns at most 100 documents per page.
 *
 * `listGcpPosts` issued one unpaginated GET and treated the result as the whole collection, so
 * once `community_posts` grew past 100 documents the community index served whichever 100 sorted
 * first by document id and dropped the rest — with no error, no log line and no partial-result
 * signal anywhere. On UAT that was 90 public posts out of 130. These tests fail if the page token
 * ever stops being followed.
 */

const ORIGINAL_ENV = { ...process.env };

/** Loads the service fresh with the GCP backend on, and a stubbed fetch it can be observed through. */
const loadService = async (fetchImpl: typeof fetch) => {
  vi.resetModules();
  vi.doMock("googleapis", () => ({
    google: {
      auth: {
        GoogleAuth: class {
          async getClient() {
            return { getRequestHeaders: async () => ({ Authorization: "Bearer test" }) };
          }
        },
      },
    },
  }));
  vi.stubGlobal("fetch", fetchImpl);
  return import("../api/community/content-service.js");
};

const document = (index: number, accessLevel = "Public") => ({
  name: `projects/p/databases/(default)/documents/community_posts/static-post-${index}`,
  fields: {
    slug: { stringValue: `general/post-${index}` },
    title: { stringValue: `Post ${index}` },
    publishedAt: { stringValue: `2026-01-${String((index % 28) + 1).padStart(2, "0")}` },
    accessLevel: { stringValue: accessLevel },
    status: { stringValue: "published" },
    sourceKind: { stringValue: "article" },
    category: { stringValue: "general" },
  },
});

beforeEach(() => {
  process.env.COMMUNITY_CONTENT_BACKEND = "gcp";
  process.env.GOOGLE_CLOUD_PROJECT = "hushh-tech-test";
  process.env.COMMUNITY_CONTENT_COLLECTION = "community_posts";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("googleapis");
  process.env = { ...ORIGINAL_ENV };
});

describe("Firestore list pagination", () => {
  it("follows the page token until the collection is exhausted", async () => {
    const pages = [
      { documents: Array.from({ length: 100 }, (_, i) => document(i)), nextPageToken: "page-2" },
      { documents: Array.from({ length: 87 }, (_, i) => document(100 + i)), nextPageToken: undefined },
    ];
    const requested: string[] = [];
    const service = await loadService((async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify(pages[requested.length - 1]), { status: 200 });
    }) as unknown as typeof fetch);

    const posts = await service.listCommunityPosts({ query: {}, headers: {} } as never);

    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("pageToken=page-2");
    expect(posts).toHaveLength(187);
  });

  it("asks for a page size instead of accepting the 100-document default", async () => {
    const requested: string[] = [];
    const service = await loadService((async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ documents: [document(1)] }), { status: 200 });
    }) as unknown as typeof fetch);

    await service.listCommunityPosts({ query: {}, headers: {} } as never);
    expect(requested[0]).toMatch(/[?&]pageSize=\d+/);
  });

  it("projects away the bodies the list response throws out anyway", async () => {
    // api/community/posts.js strips bodyMarkdown and bodyHtml before responding, so reading them
    // was ~430 KB of text fetched and discarded on every list request.
    const requested: string[] = [];
    const service = await loadService((async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ documents: [document(1)] }), { status: 200 });
    }) as unknown as typeof fetch);

    await service.listCommunityPosts({ query: {}, headers: {} } as never);
    const url = new URL(requested[0]);
    const mask = url.searchParams.getAll("mask.fieldPaths");
    expect(mask).toContain("slug");
    expect(mask).toContain("accessLevel");
    expect(mask).not.toContain("bodyMarkdown");
    expect(mask).not.toContain("bodyHtml");
  });

  it("still keeps NDA posts out of a public list across pages", async () => {
    const pages = [
      {
        documents: [
          ...Array.from({ length: 50 }, (_, i) => document(i)),
          ...Array.from({ length: 50 }, (_, i) => document(1000 + i, "NDA")),
        ],
        nextPageToken: "page-2",
      },
      { documents: Array.from({ length: 10 }, (_, i) => document(2000 + i, "NDA")) },
    ];
    let call = 0;
    const service = await loadService((async () =>
      new Response(JSON.stringify(pages[call++]), { status: 200 })) as unknown as typeof fetch);

    const posts = await service.listCommunityPosts({ query: {}, headers: {} } as never);
    expect(posts).toHaveLength(50);
    expect(posts.every((post: { accessLevel: string }) => post.accessLevel === "Public")).toBe(true);
  });
});
