import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyFirebaseBearer: vi.fn(),
  getOwnProfile: vi.fn(),
  updateOwnProfile: vi.fn(),
  getPublicProfile: vi.fn(),
}));

vi.mock("../api/shared/gcpDataRuntime.js", () => ({
  verifyFirebaseBearer: mocks.verifyFirebaseBearer,
}));

vi.mock("../api/shared/hushhProfileRepository.js", () => ({
  getOwnProfile: mocks.getOwnProfile,
  updateOwnProfile: mocks.updateOwnProfile,
  getPublicProfile: mocks.getPublicProfile,
  PROFILE_DATA_CONTRACT_NOT_READY: "PROFILE_DATA_CONTRACT_NOT_READY",
  PUBLIC_HUSHH_ID_CONTRACT_NOT_READY: "PUBLIC_HUSHH_ID_CONTRACT_NOT_READY",
}));

import privateHandler from "../api/hushh-profile.js";
import publicHandler from "../api/public-hushh-profile.js";

function response() {
  let statusCode = 200;
  let body: unknown = null;
  const headers = new Map<string, string>();
  return {
    get statusCode() { return statusCode; },
    get body() { return body; },
    headers,
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
    setHeader(name: string, value: string) { headers.set(name, value); },
  };
}

function request(method: string, options: Record<string, unknown> = {}) {
  return {
    method,
    headers: options.headers || {},
    body: options.body,
    params: options.params || {},
  } as any;
}

describe("Hushh profile API boundaries", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires Firebase authentication for the private GET", async () => {
    mocks.verifyFirebaseBearer.mockRejectedValue({ status: 401, code: "AUTH_REQUIRED" });
    const res = response();

    await privateHandler(request("GET"), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "AUTH_REQUIRED", message: "Authentication required." } });
    expect(mocks.getOwnProfile).not.toHaveBeenCalled();
  });

  it("requires Firebase authentication for the private PUT", async () => {
    mocks.verifyFirebaseBearer.mockRejectedValue({ status: 401, code: "AUTH_REQUIRED" });
    const res = response();

    await privateHandler(request("PUT", { body: { profile: {} } }), res);

    expect(res.statusCode).toBe(401);
    expect(mocks.updateOwnProfile).not.toHaveBeenCalled();
  });

  it("uses only the verified UID and returns the controlled persistence state", async () => {
    mocks.verifyFirebaseBearer.mockResolvedValue({ uid: "verified-firebase-uid" });
    mocks.getOwnProfile.mockRejectedValue({
      status: 503,
      code: "PROFILE_DATA_CONTRACT_NOT_READY",
      message: "database details must stay private",
    });
    const res = response();

    await privateHandler(request("GET", { headers: { authorization: "Bearer valid" } }), res);

    expect(mocks.getOwnProfile).toHaveBeenCalledWith("verified-firebase-uid");
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { code: "PROFILE_DATA_CONTRACT_NOT_READY", message: "Profile data is temporarily unavailable." } });
    expect(JSON.stringify(res.body)).not.toContain("database details");
  });

  it.each(["id", "userId", "user_id", "firebase_uid", "database_id", "hushh_id"])(
    "rejects client-controlled identity field %s",
    async (field) => {
      mocks.verifyFirebaseBearer.mockResolvedValue({ uid: "verified-firebase-uid" });
      const res = response();

      await privateHandler(request("PUT", {
        headers: { authorization: "Bearer valid" },
        body: { profile: {}, [field]: "attacker-value" },
      }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: { code: "IDENTITY_FIELDS_NOT_ALLOWED", message: "Profile identity is managed by authentication." } });
      expect(mocks.updateOwnProfile).not.toHaveBeenCalled();
    },
  );

  it("keeps the public endpoint unauthenticated and never interprets the ID as a Firebase UID", async () => {
    mocks.getPublicProfile.mockRejectedValue({
      status: 503,
      code: "PUBLIC_HUSHH_ID_CONTRACT_NOT_READY",
      message: "private details must stay private",
    });
    const res = response();

    await publicHandler(request("GET", { params: { hushhId: "public-test-id" } }), res);

    expect(mocks.verifyFirebaseBearer).not.toHaveBeenCalled();
    expect(mocks.getPublicProfile).toHaveBeenCalledWith("public-test-id");
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { code: "PUBLIC_HUSHH_ID_CONTRACT_NOT_READY", message: "This public profile is temporarily unavailable." } });
    expect(JSON.stringify(res.body)).not.toContain("private details");
  });

  it("rejects malformed public identifiers before repository lookup", async () => {
    const res = response();

    await publicHandler(request("GET", { params: { hushhId: "uid/with/path" } }), res);

    expect(res.statusCode).toBe(400);
    expect(mocks.getPublicProfile).not.toHaveBeenCalled();
  });

  it("registers both dedicated routes before the SPA fallback", () => {
    const source = readFileSync("server.js", "utf8");
    expect(source).toContain("app.all('/api/hushh-profile'");
    expect(source).toContain("app.all('/api/public/hushh-profile/:hushhId'");
    expect(source.indexOf("app.all('/api/public/hushh-profile/:hushhId'")).toBeLessThan(source.indexOf("app.get('*'"));
  });

  it("keeps routed profile code off the legacy members table and shows gated states", () => {
    const sourceFiles = [
      "src/services/preferences/fetchPreferences.ts",
      "src/services/preferences/savePreferences.ts",
      "src/pages/your-profile/index.tsx",
      "src/pages/hushhid/index.tsx",
    ].map((path) => readFileSync(path, "utf8")).join("\n");

    expect(sourceFiles).not.toContain('.from("members")');
    expect(sourceFiles).not.toContain(".from('members')");
    expect(sourceFiles).toContain("Profile data is temporarily unavailable.");
    expect(sourceFiles).toContain("This public profile is temporarily unavailable.");
  });
});
