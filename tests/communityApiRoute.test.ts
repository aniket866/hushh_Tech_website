import { afterEach, describe, expect, it, vi } from "vitest";

const { verifyFirebaseBearerMock, executeDataRequestMock } = vi.hoisted(() => ({
  verifyFirebaseBearerMock: vi.fn(),
  executeDataRequestMock: vi.fn(),
}));

vi.mock("../api/shared/gcpDataRuntime.js", () => ({
  verifyFirebaseBearer: verifyFirebaseBearerMock,
  executeDataRequest: executeDataRequestMock,
}));

import postsHandler from "../api/community/posts.js";
import postDetailHandler from "../api/community/post-detail.js";
import { normalizePost } from "../api/community/content-service.js";

const createRes = () => {
  const res: any = {
    statusCode: 200,
    headers: new Map<string, string>(),
    payload: undefined,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers.set(key, value);
    }),
    status: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      res.payload = payload;
      return res;
    }),
  };
  return res;
};

describe("community API routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns public community posts from the Cloud Run API fallback", async () => {
    const res = createRes();

    await postsHandler({ method: "GET" } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.posts.length).toBeGreaterThan(0);
    expect(res.payload.posts[0]).not.toHaveProperty("bodyMarkdown");
    expect(res.payload.posts.every((post: any) => post.accessLevel === "Public")).toBe(true);
    expect(res.payload.posts.some((post: any) => post.slug === "general/the-perpetual-alpha-engine")).toBe(true);
  });

  it("returns a post detail by slash slug", async () => {
    const res = createRes();

    await postDetailHandler(
      {
        method: "GET",
        params: { 0: "general/the-perpetual-alpha-engine" },
      } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.post).toMatchObject({
      slug: "general/the-perpetual-alpha-engine",
      title: "The Perpetual Alpha Engine",
      accessLevel: "Public",
      sourceKind: "deck",
    });
  });

  it("does not list NDA community posts without a signed session", async () => {
    const res = createRes();

    await postsHandler(
      {
        method: "GET",
        query: { accessLevel: "NDA" },
        headers: {},
      } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "NDA access requires sign-in" });
  });

  it("treats sensitive access aliases as NDA-gated", async () => {
    const res = createRes();

    await postsHandler(
      {
        method: "GET",
        query: { access: "sensitive" },
        headers: {},
      } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "NDA access requires sign-in" });
  });

  it("does not return an NDA post detail without a signed session", async () => {
    const res = createRes();

    await postDetailHandler(
      {
        method: "GET",
        params: { 0: "funds/fund-performance" },
        headers: {},
      } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "NDA access requires sign-in" });
  });

  it("rejects an invalid bearer token before listing NDA posts", async () => {
    verifyFirebaseBearerMock.mockRejectedValueOnce(new Error("invalid token"));
    const res = createRes();

    await postsHandler(
      {
        method: "GET",
        query: { accessLevel: "NDA" },
        headers: { authorization: "Bearer expired-token" },
      } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "Invalid or expired session" });
  });

  it("rejects authenticated users who have not signed the NDA", async () => {
    verifyFirebaseBearerMock.mockResolvedValueOnce({ uid: "unsigned-user" });
    executeDataRequestMock.mockResolvedValueOnce({ data: [] });
    const res = createRes();

    await postsHandler(
      {
        method: "GET",
        query: { accessLevel: "NDA" },
        headers: { authorization: "Bearer unsigned-token" },
      } as any,
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: "Signed NDA required" });
  });

  it("returns NDA summaries only after the bearer token has a signed NDA row", async () => {
    verifyFirebaseBearerMock.mockResolvedValueOnce({ uid: "signed-user" });
    executeDataRequestMock.mockResolvedValueOnce({
      data: [{ signed_at: "2026-06-05T00:00:00.000Z" }],
    });
    const res = createRes();

    await postsHandler(
      {
        method: "GET",
        query: { accessLevel: "NDA" },
        headers: { authorization: "Bearer signed-token" },
      } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.payload.posts.length).toBeGreaterThan(0);
    expect(res.payload.posts.every((post: any) => post.accessLevel === "NDA")).toBe(true);
    expect(res.payload.posts[0]).not.toHaveProperty("bodyMarkdown");
  });

  it("returns NDA post details only after the bearer token has a signed NDA row", async () => {
    verifyFirebaseBearerMock.mockResolvedValueOnce({ uid: "signed-user" });
    executeDataRequestMock.mockResolvedValueOnce({
      data: [{ signed_at: "2026-06-05T00:00:00.000Z" }],
    });
    const res = createRes();

    await postDetailHandler(
      {
        method: "GET",
        params: { 0: "funds/fund-performance" },
        headers: { authorization: "Bearer signed-token" },
      } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.payload.post).toMatchObject({
      slug: "funds/fund-performance",
      title: "Fund Performance",
      accessLevel: "NDA",
    });
  });

  it("does not stream sensitive community assets without a signed session", async () => {
    vi.resetModules();
    vi.stubEnv("COMMUNITY_CONTENT_BUCKET", "community-private-assets");
    const { default: guardedAssetHandler } = await import("../api/community/asset.js");
    const res = createRes();

    await guardedAssetHandler(
      {
        method: "GET",
        params: { 0: "sensitive/fund-performance.pdf" },
        headers: {},
      } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "NDA access requires sign-in" });
  });

  it("normalizes media object names to same-origin community asset URLs", () => {
    const post = normalizePost({
      slug: "market/hushh-market-update-7-april",
      title: "Hushh Market Update - 7 April",
      publishedAt: "2025-04-07",
      mediaItems: [
        "market-updates/dmu7apr/1.png",
        {
          object: "market-updates/dmu7apr/m2.png",
          alt: "Momentum chart",
        },
      ],
    });

    expect(post.mediaItems).toEqual([
      {
        name: "1.png",
        url: "/api/community/assets/market-updates/dmu7apr/1.png",
        type: "image",
        alt: "",
      },
      {
        name: "m2.png",
        url: "/api/community/assets/market-updates/dmu7apr/m2.png",
        type: "image",
        alt: "Momentum chart",
      },
    ]);
  });

  it("does not treat missing access levels as public", () => {
    expect(
      normalizePost({
        slug: "missing-access",
        title: "Missing Access",
        publishedAt: "2026-06-05",
      }).accessLevel,
    ).toBe("");
  });
});
