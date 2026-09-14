import { expect, test, type Page } from "@playwright/test";

/**
 * Apple Human Interface Guidelines, as assertions.
 *
 * The community surfaces are built to Apple's visual language, so the guidelines are the spec, not
 * a style preference. Three of them are measurable from the DOM and are the three that actually get
 * broken:
 *
 *  - **Hit targets.** "Provide ample touch targets for interactive elements… at least 44x44 pt."
 *    (HIG, Layout). A 28px icon button is the single most common violation and is invisible in
 *    review because a mouse hits it fine.
 *  - **Layout margins.** Content is inset from the edge of the display rather than running into it.
 *  - **Bars and safe areas.** Nothing tappable may sit under the floating tab bar, and no content
 *    may be lost behind it — this suite exists because the deck's own contents control was doing
 *    exactly that.
 *
 * Inline links inside body copy are deliberately exempt: HIG's 44pt rule is about controls, and
 * padding a link inside a paragraph to 44pt would wreck the typography it is embedded in.
 */

const PAGES = ["/community", "/community/general/the-medallion-blueprint"];
const MIN_TAP = 44;
const MIN_MARGIN = 16;

async function prepare(page: Page) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const sameOrigin = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return sameOrigin ? route.continue() : route.abort();
  });
}

type Control = { label: string; width: number; height: number };

/**
 * Every visible control, measured as its own border box.
 *
 * This deliberately does NOT union in a pseudo-element or child overlay used to extend a hit area.
 * The usual trick — a centred `::after` larger than the button — only works if no ancestor clips
 * it, and in this codebase `GlassPill` sets `overflow-hidden` to keep its backdrop-filter inside
 * the rounded shape. An overlay inside one is clipped back to the pill, so crediting it here would
 * report a 44pt target that a finger cannot actually reach.
 *
 * The consequence is worth stating plainly: a control inside a `GlassPill` has to be 44pt itself,
 * or the pill has to stop clipping. There is no free hit-area expansion in this header.
 */
async function controls(page: Page): Promise<Control[]> {
  return page.evaluate(
    ({ minTap }) => {
      const selector = 'button, [role="button"], [role="tab"], summary, input[type="checkbox"], input[type="radio"]';
      const inProse = (el: Element) => Boolean(el.closest("p, li, blockquote, figcaption, .prose"));
      const out: { label: string; width: number; height: number }[] = [];

      for (const el of Array.from(document.querySelectorAll(selector))) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (inProse(el)) continue;
        if (rect.width >= minTap && rect.height >= minTap) continue;

        const label =
          el.getAttribute("aria-label") ||
          (el.textContent || "").trim().slice(0, 40) ||
          `<${el.tagName.toLowerCase()} class="${(el.getAttribute("class") || "").slice(0, 60)}">`;
        out.push({ label, width: Math.round(rect.width), height: Math.round(rect.height) });
      }
      return out;
    },
    { minTap: MIN_TAP },
  );
}

for (const path of PAGES) {
  test.describe(`HIG · ${path}`, () => {
    test("every control is at least 44x44", async ({ page }) => {
      await prepare(page);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);

      const undersized = await controls(page);
      const report = undersized.map((c) => `  ${c.width}x${c.height}  ${c.label}`).join("\n");
      expect(undersized, `controls below Apple's 44x44 minimum:\n${report}`).toEqual([]);
    });

    test("content is inset from the display edge", async ({ page }) => {
      await prepare(page);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);

      const flush = await page.evaluate(
        ({ minMargin }) => {
          const viewport = document.documentElement.clientWidth;
          const offenders: string[] = [];

          /**
           * A wide table on a phone is supposed to extend past the viewport — it lives in an
           * `overflow-x: auto` box the reader swipes. Measuring its cells against the display edge
           * reports the feature as a bug, so anything inside a horizontal scroller is skipped and
           * the check stays about text that genuinely runs into the edge of the screen.
           */
          const inHorizontalScroller = (el: Element) => {
            for (let node = el.parentElement; node; node = node.parentElement) {
              const overflowX = getComputedStyle(node).overflowX;
              if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) return true;
            }
            return false;
          };

          // Text is what reads badly against the edge; a full-bleed image or divider is a choice.
          for (const el of Array.from(document.querySelectorAll("h1, h2, h3, p, li"))) {
            if (!(el.textContent || "").trim()) continue;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.left >= minMargin && viewport - rect.right >= minMargin) continue;
            if (inHorizontalScroller(el)) continue;
            offenders.push(
              `  left=${Math.round(rect.left)} right=${Math.round(viewport - rect.right)}  ${(el.textContent || "").trim().slice(0, 48)}`,
            );
          }
          return offenders;
        },
        { minMargin: MIN_MARGIN },
      );

      expect(flush, `text running closer than ${MIN_MARGIN}px to the display edge:\n${flush.join("\n")}`).toEqual([]);
    });
  });
}

test("nothing tappable hides under the floating tab bar", async ({ page }, testInfo) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, "the floating tab bar is md:hidden");

  await prepare(page);
  await page.goto("/community/general/the-medallion-blueprint", { waitUntil: "domcontentloaded" });
  // Scroll in far enough that every bottom-docked control has revealed itself.
  await page.evaluate(() => window.scrollTo(0, window.innerHeight * 2));
  await page.waitForTimeout(900);

  const collisions = await page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Primary"]');
    if (!bar) return ["the floating tab bar is not on the page at all"];
    const barBox = bar.getBoundingClientRect();
    const overlaps: string[] = [];

    for (const el of Array.from(document.querySelectorAll('button, a[href], [role="button"]'))) {
      if (bar.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const hit = rect.bottom > barBox.top && rect.top < barBox.bottom && rect.right > barBox.left && rect.left < barBox.right;
      if (!hit) continue;
      // Only a control the bar actually covers is a problem: the bar is painted above everything.
      const midpoint = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      if (midpoint && el.contains(midpoint)) continue;
      overlaps.push(`  ${el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 40)}`);
    }
    return overlaps;
  });

  expect(collisions, `controls covered by the tab bar on ${testInfo.project.name}:\n${collisions.join("\n")}`).toEqual([]);
});
