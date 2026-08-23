import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearNoHybridBrowserFixture,
  NO_HYBRID_BROWSER_FIXTURE_GLOBAL,
  resolveNoHybridBrowserFixture,
} from "../src/auth/noHybridBrowserFixture";

const root = path.resolve(import.meta.dirname, "..");

function fixture(
  persona: "firebase-user-a" | "firebase-user-b" | "firebase-admin",
  origin = "http://127.0.0.1:5173",
) {
  return {
    location: { origin },
    [NO_HYBRID_BROWSER_FIXTURE_GLOBAL]: {
      schema_version: 1,
      contract_id: "hushh-tech-no-hybrid-browser-auth-v1",
      authority: "hushh-tech-uat",
      persona,
    },
  };
}

describe("no-hybrid browser auth fixture", () => {
  it("creates two isolated UAT users with distinct fake tokens", () => {
    const userA = resolveNoHybridBrowserFixture(fixture("firebase-user-a"));
    const userB = resolveNoHybridBrowserFixture(fixture("firebase-user-b"));

    expect(userA).toMatchObject({
      status: "authenticated",
      user: {
        id: "no-hybrid-firebase-user-a",
        app_metadata: { authority: "hushh-tech-uat", fund_admin: false },
      },
    });
    expect(userB?.user?.id).toBe("no-hybrid-firebase-user-b");
    expect(userA?.session?.access_token).not.toBe(userB?.session?.access_token);
    expect(userA?.session?.access_token).toMatch(/^no-hybrid-local-fixture:/);
  });

  it("grants fund_admin only to the exact admin persona", () => {
    const admin = resolveNoHybridBrowserFixture(fixture("firebase-admin"));
    expect(admin?.user?.app_metadata).toMatchObject({
      authority: "hushh-tech-uat",
      fund_admin: true,
      fixture_persona: "firebase-admin",
    });
    expect(admin?.user?.email).toBe("firebase-admin@example.test");
  });

  it.each([
    "https://uat.hushhtech.com",
    "https://hushhtech.com",
    "http://localhost:5173",
    "http://127.0.0.1:5174",
  ])("is unavailable on non-exact origin %s", (origin) => {
    expect(resolveNoHybridBrowserFixture(fixture("firebase-user-a", origin))).toBeNull();
  });

  it("rejects unknown, incomplete, and extended descriptors", () => {
    const source = fixture("firebase-user-a");
    expect(resolveNoHybridBrowserFixture({
      ...source,
      [NO_HYBRID_BROWSER_FIXTURE_GLOBAL]: {
        ...source[NO_HYBRID_BROWSER_FIXTURE_GLOBAL],
        persona: "firebase-owner",
      },
    })).toBeNull();
    expect(resolveNoHybridBrowserFixture({
      ...source,
      [NO_HYBRID_BROWSER_FIXTURE_GLOBAL]: {
        ...source[NO_HYBRID_BROWSER_FIXTURE_GLOBAL],
        unexpected: true,
      },
    })).toBeNull();
    expect(resolveNoHybridBrowserFixture({
      location: source.location,
      [NO_HYBRID_BROWSER_FIXTURE_GLOBAL]: {
        schema_version: 1,
        persona: "firebase-user-a",
      },
    })).toBeNull();
  });

  it("clears only an exact loopback fixture", () => {
    const local = fixture("firebase-user-a");
    clearNoHybridBrowserFixture(local);
    expect(local[NO_HYBRID_BROWSER_FIXTURE_GLOBAL]).toBeUndefined();

    const uat = fixture("firebase-user-a", "https://uat.hushhtech.com");
    clearNoHybridBrowserFixture(uat);
    expect(uat[NO_HYBRID_BROWSER_FIXTURE_GLOBAL]).toBeDefined();
  });

  it("uses the Firebase custom claim instead of a hard-coded email allowlist", () => {
    const route = fs.readFileSync(
      path.join(root, "src/components/FundAdminRoute.tsx"),
      "utf8",
    );
    expect(route).toContain("user.app_metadata?.fund_admin !== true");
    expect(route).not.toMatch(/isFundAdminEmail|@hushh\.ai/);
    expect(fs.existsSync(path.join(root, "src/services/fundAdmin/allowlist.ts"))).toBe(false);
  });
});
