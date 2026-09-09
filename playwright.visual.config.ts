import { defineConfig, devices } from "@playwright/test";

/**
 * Pixel-level regression for the community surfaces.
 *
 * The community index and the deck reader are now the most layout-dense pages on the site — a
 * sticky contents rail, a bottom-docked mobile control, a stat grid, wide tables inside prose —
 * and every one of those is a thing that silently breaks at one viewport while looking correct at
 * another. Unit tests cannot see any of it.
 *
 * Deliberately NOT a port: hushh-search-console has no visual regression setup either (checked —
 * no toHaveScreenshot, no percy, no chromatic, no snapshot directories). Its Playwright projects
 * are the useful part and are mirrored here: stock device presets rather than invented viewports,
 * so a failure describes a real device.
 *
 * Runs against the built app on the real Cloud Run server — the same server.js that serves
 * production, with the static content backend so a screenshot never depends on Firestore being up.
 */

const PORT = Number(process.env.VISUAL_PORT || 5178);

export default defineConfig({
  testDir: "./tests/visual",
  // Both the pixel baselines and the HIG measurements — same three viewports, same server.
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // A screenshot diff is deterministic; a retry only hides a real flake.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",

  expect: {
    toHaveScreenshot: {
      // Font hinting and image decoding differ by a hair between runs on the same machine and by
      // more across machines. 0.2 tolerance on a pixel, capped at 1% of the image, catches a
      // shifted element without failing on a re-rendered glyph.
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "off",
    trace: "retain-on-failure",
    video: "off",
    // Every deck image is decoded before a screenshot is taken; without this the first run and the
    // baseline disagree purely on what had loaded.
    serviceWorkers: "block",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
      // Chromium refuses to start its sandbox as uid 0 and exits. That is only ever the case inside
      // a container, where the sandbox is redundant, so the flag is applied exactly there rather
      // than unconditionally — a developer running this on their own machine keeps the sandbox.
      ...(typeof process.getuid === "function" && process.getuid() === 0
        ? { args: ["--no-sandbox"] }
        : {}),
    },
  },

  projects: [
    // `browserName` is pinned on all three. The iPad and iPhone presets carry
    // `defaultBrowserType: "webkit"`, and a baseline rendered by WebKit cannot be compared against
    // one rendered by Chromium — the suite has to be one engine at three sizes, not three engines.
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    { name: "tablet", use: { ...devices["iPad (gen 7)"], browserName: "chromium" } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],

  webServer: {
    // The static content backend, on purpose: the committed snapshot is 186 posts and does not
    // move, so a diff means the layout changed rather than that someone published an article.
    command: `PORT=${PORT} NODE_ENV=production COMMUNITY_CONTENT_BACKEND=static node server.js`,
    // `port` rather than `url`: this session routes outbound HTTPS through an egress proxy, and a
    // readiness probe by URL is sent through it even for 127.0.0.1, so it never resolves.
    port: PORT,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
});
