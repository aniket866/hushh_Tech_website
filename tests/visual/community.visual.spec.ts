import { expect, test, type Page } from "@playwright/test";

/**
 * Pixel baselines for the community surfaces.
 *
 * These pages carry the layout risk in this codebase: a sticky contents rail that silently stopped
 * working site-wide when an ancestor had `overflow-x: hidden`, a contents control that exists only
 * below `lg`, a stat grid, and wide tables inside prose. All of that looks right at one width and
 * wrong at another, and no unit test can see it.
 */

const DECK = "/community/general/the-medallion-blueprint";

/**
 * Cut the page off from every origin but its own.
 *
 * Card covers fall back to Unsplash, and a third-party image is the wrong thing to hang a pixel
 * baseline on: it is slow, it can be reframed by its CDN, and on a machine without egress it never
 * resolves at all — `img.decode()` simply never settles. Blocking cross-origin requests makes the
 * deterministic SVG gradient fallback render instead, which is the same on every machine, and
 * leaves the first-party imagery this suite actually cares about untouched.
 */
async function isolate(page: Page) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const sameOrigin = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return sameOrigin ? route.continue() : route.abort();
  });
}

const STABILISING_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
  /* Live prices change between runs; the band's geometry is what matters here. */
  [data-hushh-ticker] { visibility: hidden !important; }
`;

/**
 * Cut off cross-origin traffic and kill motion, before the first byte of the page runs.
 *
 * The stylesheet goes in through an init script rather than `page.addStyleTag`, which rejects if
 * *any* CSP violation is recorded on the page while it runs — including one raised by a script
 * this test does not care about. An init script is not subject to that coupling, and it also lands
 * the rules before first paint instead of after, so no animation gets a frame to run in.
 */
async function prepare(page: Page) {
  await isolate(page);
  await page.addInitScript((css: string) => {
    const install = () => {
      const style = document.createElement("style");
      style.setAttribute("data-visual-test", "");
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  }, STABILISING_CSS);
}

/**
 * Everything else that makes two screenshots of an unchanged page differ: lazy images that have
 * not decoded, and a font swap caught mid-flight.
 */
async function settle(page: Page) {
  // Force every lazy image to decode before the shutter, or the baseline captures placeholders.
  // Bounded: a decode on an image whose request was aborted never settles, and an unbounded await
  // here turns a missing asset into a 60-second test timeout rather than a visible diff.
  //
  // Fonts are waited on for the same reason — a screenshot taken mid-swap captures the fallback
  // face and every glyph lands a pixel or two off the baseline.
  await page.evaluate(async () => {
    const withTimeout = (promise: Promise<unknown>) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 1500))]);
    await withTimeout(document.fonts.ready);
    await Promise.all(
      Array.from(document.images).map((image) => {
        image.loading = "eager";
        return image.complete ? Promise.resolve() : withTimeout(image.decode().catch(() => {}));
      }),
    );
  });
  // Deliberately NOT `waitForLoadState("networkidle")`. The market band polls on an interval, so
  // the network is never idle on this site and that wait burns the entire test timeout without
  // ever resolving.
  await page.waitForTimeout(400);
}

test.describe("community index", () => {
  test("above the fold", async ({ page }) => {
    await prepare(page);
    await page.goto("/community", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("community-top.png");
  });

  test("card grid", async ({ page }) => {
    await prepare(page);
    await page.goto("/community", { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 2200));
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("community-grid.png");
  });
});

test.describe("deck reader", () => {
  test("hero and contents", async ({ page }) => {
    await prepare(page);
    await page.goto(DECK, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("deck-top.png");
  });

  test("a card with a table", async ({ page }) => {
    await prepare(page);
    await page.goto(DECK, { waitUntil: "domcontentloaded" });
    await settle(page);
    // Wide tables inside prose are the thing most likely to push the page sideways on a phone.
    const anchored = await page.evaluate(() => {
      const section = [...document.querySelectorAll("section[id]")].find((s) => s.querySelector("table"));
      section?.scrollIntoView({ block: "start" });
      return Boolean(section);
    });
    expect(anchored, "no card in this deck carries a table").toBe(true);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("deck-table.png");
  });

  test("a card with stat figures", async ({ page }) => {
    await prepare(page);
    await page.goto(DECK, { waitUntil: "domcontentloaded" });
    await settle(page);
    // 256 of these were being dropped entirely; this is the guard that they still render.
    const anchored = await page.evaluate(() => {
      const figure = document.querySelector("[data-figure]");
      figure?.closest("section")?.scrollIntoView({ block: "start" });
      return Boolean(figure);
    });
    expect(anchored, "no stat figure rendered — check the converter's DERIVED_ATTRS").toBe(true);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("deck-stats.png");
  });
});

/**
 * The contents control is the one piece of UI that is supposed to look completely different by
 * viewport, so it gets assertions rather than only a picture.
 */
test.describe("contents navigation is viewport-correct", () => {
  test("wide viewports show the rail, narrow ones show the docked control", async ({ page }) => {
    await prepare(page);
    await page.goto(DECK, { waitUntil: "domcontentloaded" });
    await settle(page);

    const rail = page.locator('nav[aria-label="Deck contents"]');
    const dock = page.locator('[aria-haspopup="dialog"]');

    // Branch on the actual breakpoint, not the project name. The iPad preset is 810 CSS px wide,
    // which is below Tailwind's `lg`, so it gets the docked control exactly like a phone does —
    // keying this off "is the project called mobile" asserted the desktop layout on a tablet.
    const wide = (page.viewportSize()?.width ?? 0) >= 1024;

    if (!wide) {
      await expect(rail).toBeHidden();
      // It is held back until the reader is a screen in, so it should not be showing yet.
      await expect(dock).not.toBeVisible();
      await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.5));
      await page.waitForTimeout(600);
      await expect(dock).toBeVisible();
      await expect(page).toHaveScreenshot("deck-dock.png");

      await dock.click();
      const sheet = page.getByRole("dialog", { name: "Deck contents" });
      await expect(sheet).toBeVisible();
      expect(await sheet.locator("ol li").count()).toBeGreaterThan(10);
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot("deck-sheet.png");
    } else {
      await expect(rail).toBeVisible();
      // The dock is `lg:hidden`, so it is present in the DOM and merely not painted. Visibility is
      // the property under test — asserting on count would pass only by accident of how it is hidden.
      await expect(dock).not.toBeVisible();
    }
  });

  test("the rail stays pinned when the page scrolls", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the rail only exists at lg and above");
    await prepare(page);
    await page.goto(DECK, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 4000));
    await page.waitForTimeout(600);
    // `overflow-x: hidden` on body and #root made every sticky element on this site inert. If that
    // regresses, the rail scrolls off and this catches it.
    const top = await page.locator('nav[aria-label="Deck contents"] > div').evaluate((el) => el.getBoundingClientRect().top);
    expect(top, "the contents rail scrolled away — check for overflow on an ancestor").toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(400);
  });
});

test("no page scrolls sideways", async ({ page }) => {
  await prepare(page);
  for (const path of ["/community", DECK]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await settle(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
