import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { authorizeDeploymentsRequest } from "../api/deployments.js";

const ENV = {
  FIREBASE_PROJECT_ID: "hushh-tech-uat",
  GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
};
const BASE_CLAIMS = {
  aud: "hushh-tech-uat",
  auth_time: 1_787_000_000,
  iss: "https://securetoken.google.com/hushh-tech-uat",
  sub: "firebase-admin-user",
  uid: "firebase-admin-user",
};

function request(token = "signed-token") {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe("deployments Firebase authorization", () => {
  it("contains no shared password or client-side credential storage", () => {
    const files = [
      "api/deployments.js",
      "src/pages/deployments/logic.ts",
      "src/pages/deployments/ui.tsx",
    ].map((relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
    const source = files.join("\n");
    expect(source).not.toContain("DEPLOYMENTS_DASHBOARD_PASSWORD");
    expect(source).not.toContain("123456");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("x-dashboard-password");
  });

  it("accepts only an exact UAT deployment_admin claim", async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({
      ...BASE_CLAIMS,
      deployment_admin: true,
    });

    await expect(
      authorizeDeploymentsRequest(request(), { env: ENV, verifyIdToken }),
    ).resolves.toEqual({ uid: "firebase-admin-user" });
    expect(verifyIdToken).toHaveBeenCalledWith("signed-token");
  });

  it.each([undefined, false, "true", 1])(
    "rejects deployment_admin=%p",
    async (deploymentAdmin) => {
      await expect(
        authorizeDeploymentsRequest(request(), {
          env: ENV,
          verifyIdToken: vi.fn().mockResolvedValue({
            ...BASE_CLAIMS,
            deployment_admin: deploymentAdmin,
          }),
        }),
      ).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    },
  );

  it("rejects a missing bearer before verification", async () => {
    const verifyIdToken = vi.fn();
    await expect(
      authorizeDeploymentsRequest({ headers: {} }, { env: ENV, verifyIdToken }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects an expired or revoked token", async () => {
    await expect(
      authorizeDeploymentsRequest(request(), {
        env: ENV,
        verifyIdToken: vi.fn().mockRejectedValue(Object.assign(new Error("expired"), { code: "auth/id-token-expired" })),
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID", status: 401 });
  });

  it("rejects any non-UAT runtime authority", async () => {
    const verifyIdToken = vi.fn();
    await expect(
      authorizeDeploymentsRequest(request(), {
        env: { ...ENV, GOOGLE_CLOUD_PROJECT: "hushh-tech-prod" },
        verifyIdToken,
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE", status: 503 });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    { aud: "hushh-tech-prod" },
    { iss: "https://securetoken.google.com/hushh-tech-prod" },
    { sub: "other-user" },
    { auth_time: "1787000000" },
  ])("rejects token authority drift %#", async (change) => {
    await expect(
      authorizeDeploymentsRequest(request(), {
        env: ENV,
        verifyIdToken: vi.fn().mockResolvedValue({
          ...BASE_CLAIMS,
          deployment_admin: true,
          ...change,
        }),
      }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID", status: 401 });
  });
});
