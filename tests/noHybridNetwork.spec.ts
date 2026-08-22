import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { installNoHybridNetworkGate } from "./noHybridNetworkGuard";

const inventory = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "tests/noHybridRouteInventory.generated.json"), "utf8"),
);

type FixturePersona = "firebase-user-a" | "firebase-user-b" | "firebase-admin";
type InventoryClientRoute = {
  pattern: string;
  sample: string;
  terminal: string;
  access: "anonymous" | "firebase-user" | "firebase-admin";
  render: { selector: string; text?: string };
};

async function installAuthFixture(
  context: BrowserContext,
  persona: FixturePersona,
) {
  await context.addInitScript((selectedPersona) => {
    window.__HUSHH_NO_HYBRID_AUTH_FIXTURE__ = {
      schema_version: 1,
      contract_id: "hushh-tech-no-hybrid-browser-auth-v1",
      authority: "hushh-tech-uat",
      persona: selectedPersona,
    };
  }, persona);
}

function investorProfileFixture(persona: FixturePersona) {
  return {
    user_id: `no-hybrid-${persona}`,
    name: "Automated Investor",
    email: `${persona}@example.test`,
    age: 35,
    phone_country_code: "+1",
    phone_number: "5550100000",
    organisation: null,
    confirmed_at: "2026-01-01T00:00:00.000Z",
    investor_profile: {
      primary_goal: {
        value: "long_term_growth",
        confidence: 0.9,
        rationale: "Deterministic browser fixture.",
      },
    },
  };
}

async function installAuthenticatedApiFixture(
  context: BrowserContext,
  persona: FixturePersona,
) {
  const authorization = new Set<string>();
  context.on("request", (request) => {
    const header = request.headers().authorization;
    if (header) authorization.add(header);
  });
  await context.route("**/api/**", async (route) => {
    let data: unknown = [];
    if (new URL(route.request().url()).pathname === "/api/gcp/data") {
      let body: Record<string, unknown> = {};
      try {
        body = route.request().postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (body.table === "onboarding_data") {
        data = {
          current_step: 13,
          is_completed: true,
          financial_link_status: "completed",
          fund_payment_status: "paid",
          fund_investor_verification_status: "verified_investor",
        };
      } else if (body.table === "user_financial_data") {
        data = { status: "complete" };
      } else if (body.table === "investor_profiles") {
        data = investorProfileFixture(persona);
      } else if (body.kind === "rpc" && body.name === "check_user_nda_status") {
        data = {
          hasSignedNda: true,
          signedAt: "2026-01-01T00:00:00.000Z",
          ndaVersion: "fixture-v1",
          signerName: "Automated fixture",
        };
      } else if (body.cardinality === "single" || body.cardinality === "maybe-single") {
        data = null;
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, count: Array.isArray(data) ? data.length : null }),
    });
  });
  return authorization;
}

async function assertRouteReady(page: Page, route: InventoryClientRoute) {
  await expect.poll(() => new URL(page.url()).pathname, {
    message: `${route.pattern} did not reach terminal ${route.terminal}`,
  }).toBe(route.terminal);
  const rendered = page.locator(route.render.selector).first();
  await expect(rendered, `${route.pattern} rendered an empty application root`).toBeAttached();
  await expect.poll(
    () => rendered.evaluate((node) => {
      const text = node.textContent?.trim() || "";
      return text.length > 0 || Boolean(node.querySelector("button, canvas, img, input, svg, video"));
    }),
    { message: `${route.pattern} has no observable rendered surface` },
  ).toBe(true);
  if (route.render.text) {
    await expect(
      page.getByText(route.render.text, { exact: false }).first(),
      `${route.pattern} is missing its route-specific rendered contract`,
    ).toBeVisible();
  }
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");
}

async function newFixtureContext(browser: Browser, persona: FixturePersona) {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    bypassCSP: true,
    serviceWorkers: "block",
  });
  await installAuthFixture(context, persona);
  return context;
}

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

test("generated anonymous routes reach their exact terminal surfaces without provider egress", async ({ context, page }) => {
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

  const anonymousRoutes = inventory.client.filter(
    (entry: InventoryClientRoute) => entry.access === "anonymous",
  );
  for (const route of anonymousRoutes) {
    await page.goto(route.sample, { waitUntil: "domcontentloaded" });
    await assertRouteReady(page, route);
    networkGate.assertClean();
  }

  expect(pageErrors).toEqual([]);
  expect(anonymousRoutes).toHaveLength(inventory.counts.client_anonymous);
});

test("two isolated Firebase users reach every authenticated React route without provider egress", async ({ browser }) => {
  test.setTimeout(180_000);
  const observedTokens = new Set<string>();

  for (const persona of ["firebase-user-a", "firebase-user-b"] as const) {
    const context = await newFixtureContext(browser, persona);
    const networkGate = await installNoHybridNetworkGate(context);
    const authorization = await installAuthenticatedApiFixture(context, persona);
    const page = await context.newPage();

    for (const route of inventory.client.filter((entry: { access: string }) => entry.access === "firebase-user")) {
      await page.goto(route.sample, { waitUntil: "domcontentloaded" });
      await assertRouteReady(page, route);
      networkGate.assertClean();
    }

    for (const token of authorization) observedTokens.add(token);
    expect([...authorization]).toEqual([`Bearer no-hybrid-local-fixture:${persona}`]);
    await context.close();
  }

  expect([...observedTokens].sort()).toEqual([
    "Bearer no-hybrid-local-fixture:firebase-user-a",
    "Bearer no-hybrid-local-fixture:firebase-user-b",
  ]);
  expect(inventory.counts.client_user).toBe(22);
});

test("Firebase fund admin reaches every admin route and a regular user is denied", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminContext = await newFixtureContext(browser, "firebase-admin");
  const adminGate = await installNoHybridNetworkGate(adminContext);
  const adminAuthorization = await installAuthenticatedApiFixture(adminContext, "firebase-admin");
  const adminPage = await adminContext.newPage();

  const adminRoutes = inventory.client.filter(
    (entry: { access: string }) => entry.access === "firebase-admin",
  );
  for (const route of adminRoutes) {
    await adminPage.goto(route.sample, { waitUntil: "domcontentloaded" });
    await assertRouteReady(adminPage, route);
    adminGate.assertClean();
  }
  expect([...adminAuthorization]).toEqual([
    "Bearer no-hybrid-local-fixture:firebase-admin",
  ]);
  await adminContext.close();

  const userContext = await newFixtureContext(browser, "firebase-user-a");
  const userGate = await installNoHybridNetworkGate(userContext);
  await installAuthenticatedApiFixture(userContext, "firebase-user-a");
  const userPage = await userContext.newPage();
  await userPage.goto(adminRoutes[0].sample, { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(userPage.url()).pathname).toBe("/");
  userGate.assertClean();
  await userContext.close();

  expect(inventory.counts.client_admin).toBe(3);
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
