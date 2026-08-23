import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "noHybridNetwork.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    bypassCSP: true,
    serviceWorkers: "block",
    screenshot: "off",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // The no-hybrid orchestrator builds first. Exercise the authoritative
    // Cloud Run server and its same-origin API routes, not Vite's static-only
    // preview server.
    command: "PORT=5173 NODE_ENV=test node server.js",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
});
