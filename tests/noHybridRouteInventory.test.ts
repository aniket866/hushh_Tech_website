import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildNoHybridRouteInventory,
  clientRoutes,
} from "../scripts/ci/generate-no-hybrid-route-inventory.mjs";

const root = path.resolve(import.meta.dirname, "..");
const generatedPath = path.join(root, "tests/noHybridRouteInventory.generated.json");

describe("no-hybrid exhaustive route inventory", () => {
  it("is deterministically generated from React, Express, and the function registry", async () => {
    const observed = await buildNoHybridRouteInventory(root);
    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
    expect(observed).toEqual(generated);
    expect(observed.counts).toEqual({
      client: 94,
      client_anonymous: 69,
      client_user: 22,
      client_admin: 3,
      server: 35,
      functions: 112,
      functions_ported: 8,
      functions_retired: 1,
      functions_blocked: 103,
    });
  });

  it("requires two isolated users and an admin under the UAT Firebase authority", async () => {
    const inventory = await buildNoHybridRouteInventory(root);
    expect(inventory.target_project).toBe("hushh-tech-uat");
    expect(inventory.browsers).toEqual(["chromium", "webkit"]);
    expect(inventory.personas).toEqual([
      { id: "anonymous", authority: "none" },
      { id: "firebase-user-a", authority: "hushh-tech-uat" },
      { id: "firebase-user-b", authority: "hushh-tech-uat" },
      { id: "firebase-admin", authority: "hushh-tech-uat", claim: "fund_admin" },
    ]);
    expect(inventory.client.filter((route: any) => route.access === "firebase-user")).toHaveLength(22);
    expect(inventory.client.filter((route: any) => route.access === "firebase-admin")).toHaveLength(3);
    expect(inventory.client.find((route: any) => route.pattern === "/profile/:id")).toMatchObject({
      sample: "/profile/fixture-id",
      terminal: "/profile/fixture-id",
      access: "firebase-user",
      render: { selector: "#root > *", text: "Verified Investor" },
    });
    expect(inventory.client.find((route: any) => route.pattern === "/user-registration")).toMatchObject({
      terminal: "/hushh-user-profile",
      access: "firebase-user",
    });
    expect(inventory.client.find((route: any) => route.pattern === "/career/:jobId")).toMatchObject({
      sample: "/career/quantitative-research-scientist",
      terminal: "/career/quantitative-research-scientist",
      source_owner: "src/pages/career/index.tsx",
      render: { selector: "#root > *", text: "Quantitative Research Scientist" },
    });
    for (const [pattern, terminal] of Object.entries({
      "/a2a-playground": "/",
      "/kyc": "/",
      "/kyc-demo": "/",
      "/kyc-flow": "/",
      "/kyc-form": "/",
      "/kyc-verification": "/",
      "/metric": "/metrics",
      "/onboarding/step-7": "/login",
      "/onboarding/step-8": "/login",
      "/onboarding/step-9": "/login",
      "/sign-nda": "/login",
    })) {
      expect(inventory.client.find((route: any) => route.pattern === pattern)?.terminal).toBe(
        terminal,
      );
    }
  });

  it("fails closed when a new React Routes owner is not registered", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-route-owners-"));
    try {
      fs.mkdirSync(path.join(temporaryRoot, "src/pages/career"), { recursive: true });
      fs.writeFileSync(
        path.join(temporaryRoot, "src/App.tsx"),
        '<Routes><Route path="/" element={<main />} /></Routes>',
      );
      fs.writeFileSync(
        path.join(temporaryRoot, "src/pages/career/index.tsx"),
        '<Routes><Route path="/:jobId" element={<main />} /></Routes>',
      );
      fs.writeFileSync(
        path.join(temporaryRoot, "src/hidden-router.tsx"),
        '<Routes><Route path="/hidden" element={<main />} /></Routes>',
      );
      expect(() => clientRoutes(temporaryRoot)).toThrow(/React Routes owners drifted/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the cutover red while 103 function routes are not implemented", async () => {
    const inventory = await buildNoHybridRouteInventory(root);
    expect(inventory.functions.filter((route: any) => route.disposition === "RETIRE_WITH_410").map((route: any) => route.slug)).toEqual(["get-secrets"]);
    expect(inventory.functions.filter((route: any) => route.state === "PORTED_AND_VERIFIED").map((route: any) => route.slug)).toEqual([
      "asset-report-create",
      "create-link-token",
      "exchange-public-token",
      "hushh-location-geocode",
      "plaid-data-sync",
      "plaid-data-sync-product",
      "plaid-data-sync-start",
      "plaid-diagnostics-log",
    ]);
    expect(inventory.counts.functions_blocked).toBe(103);
  });

  it("captures all GCP data/storage methods and the compatibility wildcard", async () => {
    const inventory = await buildNoHybridRouteInventory(root);
    const byPattern = new Map(inventory.server.map((route: any) => [route.pattern, route.methods]));
    expect(byPattern.get("/api/gcp/data")).toEqual(["POST"]);
    expect(byPattern.get("/api/gcp/storage")).toEqual(["DELETE", "POST"]);
    expect(byPattern.get("/api/gcp/storage/*")).toEqual(["GET", "PUT"]);
    expect(byPattern.get("/functions/v1/*")).toEqual(["ALL"]);
  });
});
