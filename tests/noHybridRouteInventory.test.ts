import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildNoHybridRouteInventory } from "../scripts/ci/generate-no-hybrid-route-inventory.mjs";

const root = path.resolve(import.meta.dirname, "..");
const generatedPath = path.join(root, "tests/noHybridRouteInventory.generated.json");

describe("no-hybrid exhaustive route inventory", () => {
  it("is deterministically generated from React, Express, and the function registry", async () => {
    const observed = await buildNoHybridRouteInventory(root);
    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
    expect(observed).toEqual(generated);
    expect(observed.counts).toEqual({
      client: 93,
      client_anonymous: 68,
      client_user: 22,
      client_admin: 3,
      server: 32,
      functions: 112,
      functions_ported: 0,
      functions_retired: 1,
      functions_blocked: 111,
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
  });

  it("keeps the cutover red while 111 function routes are not implemented", async () => {
    const inventory = await buildNoHybridRouteInventory(root);
    expect(inventory.functions.filter((route: any) => route.disposition === "RETIRE_WITH_410").map((route: any) => route.slug)).toEqual(["get-secrets"]);
    expect(inventory.functions.filter((route: any) => route.state === "PORTED_AND_VERIFIED")).toEqual([]);
    expect(inventory.counts.functions_blocked).toBe(111);
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
