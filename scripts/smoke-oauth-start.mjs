import { chromium } from "@playwright/test";
import {
  assertUatOrigin,
  createUatOAuthEvidence,
  safeLocation,
  verifyFirebaseHelper,
} from "./shared/firebaseAuthSmoke.mjs";

const baseUrl = process.argv[2];
const uatAuthDomain = process.argv.includes("--uat-auth-domain");

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-oauth-start.mjs <base-url>");
  process.exit(1);
}

const loginUrl = new URL("/login", baseUrl).toString();
const signupUrl = new URL("/signup", baseUrl).toString();
const profileUrl = new URL("/profile", baseUrl).toString();
const investorProfileUrl = new URL("/investor-profile", baseUrl).toString();
const financialLinkUrl = new URL("/onboarding/financial-link", baseUrl).toString();
const ndaPostUrl = new URL("/community/funds/fund-performance", baseUrl).toString();
const legacyLoginRedirectUrl = new URL(
  "/login?redirect=%2Finvestor-profile",
  baseUrl
).toString();
const legacySignupRedirectUrl = new URL(
  "/signup?redirect=%2Finvestor-profile",
  baseUrl
).toString();

async function gotoPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
}

async function verifyProviderRedirect(buttonName, expectedHosts, startUrl = loginUrl) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  const provider = /apple/i.test(buttonName) ? "apple" : "google";
  const evidence = uatAuthDomain ? createUatOAuthEvidence(provider) : null;
  if (evidence) page.on("request", (request) => evidence.observe(request.url()));

  try {
    await gotoPage(page, startUrl);
    const button = page.getByRole("button", { name: new RegExp(buttonName, "i") });
    await button.click({ timeout: 5000 });

    await page.waitForURL(
      (value) => {
        const current = new URL(value.toString());
        return uatAuthDomain
          ? current.protocol === "https:" && current.hostname === (provider === "apple" ? "appleid.apple.com" : "accounts.google.com")
          : expectedHosts.some((host) => current.hostname.includes(host));
      },
      { timeout: 15000 }
    );

    return evidence ? evidence.verify() : safeLocation(page.url());
  } finally {
    await browser.close();
  }
}

async function verifyRedirect(startUrl, expectedPathname, expectedRedirect) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });

  try {
    await gotoPage(page, startUrl);
    await page.waitForURL(
      (value) => {
        const current = new URL(value.toString());
        if (current.pathname !== expectedPathname) {
          return false;
        }

        if (!expectedRedirect) {
          return true;
        }

        return current.searchParams.get("redirect") === expectedRedirect;
      },
      { timeout: 15000 }
    );

    return safeLocation(page.url());
  } finally {
    await browser.close();
  }
}

async function verifyCanonicalizedAuthEntry(startUrl, expectedPathname, expectedRedirect) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });

  try {
    await gotoPage(page, startUrl);
    await page.waitForURL(
      (value) => {
        const current = new URL(value.toString());
        return (
          current.pathname === expectedPathname &&
          current.searchParams.get("redirect") === expectedRedirect
        );
      },
      { timeout: 15000 }
    );

    return safeLocation(page.url());
  } finally {
    await browser.close();
  }
}

async function main() {
  if (uatAuthDomain) assertUatOrigin(baseUrl);
  const helper = uatAuthDomain ? await verifyFirebaseHelper(baseUrl) : undefined;
  const results = {
    login: safeLocation(loginUrl),
    helper,
    apple: await verifyProviderRedirect("Continue with Apple", [
      "firebaseapp.com",
      "appleid.apple.com",
    ]),
    google: await verifyProviderRedirect("Continue with Google", [
      "firebaseapp.com",
      "google.com",
      "accounts.google.com",
    ]),
    appleSignup: uatAuthDomain ? await verifyProviderRedirect("Continue with Apple", [], signupUrl) : undefined,
    googleSignup: uatAuthDomain ? await verifyProviderRedirect("Continue with Google", [], signupUrl) : undefined,
    guestProfilePage: await verifyRedirect(profileUrl, "/profile"),
    investorProfileAliasRedirect: await verifyRedirect(
      investorProfileUrl,
      "/login",
      "/onboarding/financial-link"
    ),
    legacyLoginRedirectCanonicalization: await verifyCanonicalizedAuthEntry(
      legacyLoginRedirectUrl,
      "/login",
      "/onboarding/financial-link"
    ),
    legacySignupRedirectCanonicalization: await verifyCanonicalizedAuthEntry(
      legacySignupRedirectUrl,
      "/signup",
      "/onboarding/financial-link"
    ),
    guestFinancialLinkRedirect: await verifyRedirect(
      financialLinkUrl,
      "/login",
      "/onboarding/financial-link"
    ),
    guestNdaPostRedirect: await verifyRedirect(ndaPostUrl, "/community"),
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch(() => {
  // Playwright exceptions include navigation URLs; never print the raw error.
  console.error(JSON.stringify({ status: "failed", check: "oauth-startup", authenticated: false }));
  process.exitCode = 1;
});
