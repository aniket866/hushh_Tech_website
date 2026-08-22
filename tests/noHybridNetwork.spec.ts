import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { installNoHybridNetworkGate } from "./noHybridNetworkGuard";

const inventory = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "tests/noHybridRouteInventory.generated.json"), "utf8"),
);

test("synthetic GCP-only browser fixture stays clean", async ({ context, page }) => {
  const networkGate = await installNoHybridNetworkGate(context);

  await page.goto("/robots.txt", { waitUntil: "domcontentloaded" });
  await page.setContent(`
    <main id="fixture" data-database="cloud-sql" data-auth="identity-platform"
      data-storage="cloud-storage" data-functions="cloud-run">
      <output id="health">pending</output>
    </main>
    <script>
      fetch("/robots.txt")
        .then((response) => {
          document.querySelector("#health").textContent = response.ok ? "gcp-only-ready" : "failed";
        })
        .catch(() => {
          document.querySelector("#health").textContent = "failed";
        });
    </script>
  `);

  await expect(page.locator("#health")).toHaveText("gcp-only-ready");
  await expect(page.locator("#fixture")).toHaveAttribute("data-database", "cloud-sql");
  await expect(page.locator("#fixture")).toHaveAttribute("data-auth", "identity-platform");
  networkGate.assertClean();
});

test("synthetic forbidden provider request is intercepted and rejected", async ({ context, page }) => {
  const networkGate = await installNoHybridNetworkGate(context);

  await page.goto("/robots.txt", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    try {
      await fetch("https://tenant.supabase.co/rest/v1/profiles");
      return "unexpected-success";
    } catch {
      return "blocked";
    }
  });

  expect(result).toBe("blocked");
  expect([...networkGate.blocked]).toEqual([
    "https://tenant.supabase.co/rest/v1/profiles",
  ]);
  expect(() => networkGate.assertClean()).toThrowError(
    /No-hybrid browser gate blocked provider requests/,
  );
});

test("alternate provider domains and retired project refs are recorded as violations", async ({ context, page }) => {
  const networkGate = await installNoHybridNetworkGate(context);

  await page.goto("/robots.txt", { waitUntil: "domcontentloaded" });
  const urls = [
    "https://tenant.supabase.com/rest/v1/profiles",
    "https://tenant.supabase.in/auth/v1/user",
    "https://gcp.example/proxy/ibsisfnjxeowvdtvgzff/functions/v1/stock-quotes",
  ];
  const results = await page.evaluate(async (targets) =>
    Promise.all(
      targets.map(async (target) => {
        try {
          await fetch(target);
          return "unexpected-success";
        } catch {
          return "blocked";
        }
      }),
    ), urls);

  expect(results).toEqual(["blocked", "blocked", "blocked"]);
  expect([...networkGate.blocked].sort()).toEqual([...urls].sort());
  expect(() => networkGate.assertClean()).toThrowError(
    /No-hybrid browser gate blocked provider requests/,
  );
});

test("synthetic forbidden provider WebSocket is closed without connecting", async ({ context, page }) => {
  const networkGate = await installNoHybridNetworkGate(context);

  await page.goto("/robots.txt", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket("wss://tenant.supabase.co/realtime/v1/websocket");
        let settled = false;
        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        socket.addEventListener("open", () => finish("unexpected-open"), { once: true });
        socket.addEventListener("error", () => finish("blocked"), { once: true });
        socket.addEventListener("close", () => finish("blocked"), { once: true });
      }),
  );

  expect(result).toBe("blocked");
  expect([...networkGate.blocked]).toEqual([
    "wss://tenant.supabase.co/realtime/v1/websocket",
  ]);
  expect(() => networkGate.assertClean()).toThrowError(
    /No-hybrid browser gate blocked provider requests/,
  );
});

test("network guard samples five unauthenticated application routes", async ({ context, page }) => {
  const networkGate = await installNoHybridNetworkGate(context);

  for (const route of ["/", "/login", "/signup", "/metrics", "/delete-account"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toBeAttached();
    networkGate.assertClean();
  }
});

test("generated anonymous inventory reaches every React route without provider egress", async ({ context, page }) => {
  test.setTimeout(120_000);
  const networkGate = await installNoHybridNetworkGate(context);
  await context.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, PATCH, POST, PUT",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: { code: "DETERMINISTIC_FIXTURE", message: "Unavailable in anonymous route proof." } }),
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  for (const route of inventory.client) {
    await page.goto(route.sample, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root"), route.pattern).toBeAttached();
    // WebKit reports fetches aborted by the next navigation as page errors.
    // Let route-started same-origin work settle so the assertion observes the
    // route itself instead of an artificial cancellation from this sweep.
    await page.waitForTimeout(100);
    networkGate.assertClean();
  }

  expect(pageErrors).toEqual([]);
  expect(inventory.counts.client).toBe(93);
});

test("all 112 compatibility routes have an explicit terminal or blocking response", async ({ context, page }) => {
  test.setTimeout(60_000);
  const networkGate = await installNoHybridNetworkGate(context);
  await page.goto("/robots.txt", { waitUntil: "domcontentloaded" });

  const observed = await page.evaluate(async (routes) => {
    const results = [];
    for (const route of routes) {
      const response = await fetch(route.route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json();
      results.push({ slug: route.slug, status: response.status, code: payload?.detail?.code });
    }
    return results;
  }, inventory.functions);

  expect(observed).toHaveLength(112);
  expect(observed.filter((entry) => entry.status === 410)).toEqual([
    { slug: "get-secrets", status: 410, code: "FEATURE_RETIRED" },
  ]);
  expect(observed.filter((entry) => entry.status === 503)).toHaveLength(111);
  expect(new Set(observed.filter((entry) => entry.status === 503).map((entry) => entry.code))).toEqual(
    new Set(["FUNCTION_NOT_MIGRATED"]),
  );
  networkGate.assertClean();
});
