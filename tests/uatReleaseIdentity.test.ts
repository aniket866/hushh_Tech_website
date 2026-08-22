import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { app } from "../server.js";

const ORIGINAL_ENV = {
  DEPLOY_COMMIT_SHA: process.env.DEPLOY_COMMIT_SHA,
  K_REVISION: process.env.K_REVISION,
  K_SERVICE: process.env.K_SERVICE,
};

async function requestRelease() {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/release`,
    );
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json(),
    };
  } finally {
    server.close();
    await once(server, "close");
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("UAT release identity", () => {
  it("returns the exact full Git SHA and Cloud Run revision without caching", async () => {
    process.env.DEPLOY_COMMIT_SHA = "a".repeat(40);
    process.env.K_REVISION = "hushh-tech-website-00227-release";
    process.env.K_SERVICE = "hushh-tech-website";

    await expect(requestRelease()).resolves.toEqual({
      status: 200,
      cacheControl: "no-store",
      body: {
        status: "ok",
        service: "hushh-tech-website",
        revision: "hushh-tech-website-00227-release",
        commit_sha: "a".repeat(40),
      },
    });
  });

  it.each([
    ["short SHA", "a".repeat(8), "hushh-tech-website-00227-release", "hushh-tech-website"],
    ["uppercase SHA", "A".repeat(40), "hushh-tech-website-00227-release", "hushh-tech-website"],
    ["missing revision", "a".repeat(40), "", "hushh-tech-website"],
    ["wrong service", "a".repeat(40), "hushh-tech-website-00227-release", "other-service"],
  ])("fails closed for %s", async (_case, sha, revision, service) => {
    process.env.DEPLOY_COMMIT_SHA = sha;
    process.env.K_REVISION = revision;
    process.env.K_SERVICE = service;

    await expect(requestRelease()).resolves.toMatchObject({
      status: 503,
      cacheControl: "no-store",
      body: {
        status: "unavailable",
        code: "RELEASE_IDENTITY_UNAVAILABLE",
      },
    });
  });
});
