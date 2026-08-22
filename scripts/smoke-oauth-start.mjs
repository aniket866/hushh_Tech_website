import { chromium } from "@playwright/test";

const baseUrl = process.argv[2];

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-oauth-start.mjs <base-url>");
  process.exit(1);
}

const loginUrl = new URL("/login", baseUrl).toString();
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

async function verifyProviderRedirect(buttonName, expectedHosts) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });

  try {
    await gotoPage(page, loginUrl);
    const button = page.getByRole("button", { name: new RegExp(buttonName, "i") });
    await button.click({ timeout: 5000 });

    await page.waitForURL(
      (value) => {
        const current = new URL(value.toString());
        return expectedHosts.some((host) => current.hostname.includes(host));
      },
      { timeout: 15000 }
    );

    return page.url();
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

    return page.url();
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

    return page.url();
  } finally {
    await browser.close();
  }
}

const results = {
  loginUrl,
  apple: await verifyProviderRedirect("Continue with Apple", [
    "firebaseapp.com",
    "appleid.apple.com",
  ]),
  google: await verifyProviderRedirect("Continue with Google", [
    "firebaseapp.com",
    "google.com",
    "accounts.google.com",
  ]),
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
