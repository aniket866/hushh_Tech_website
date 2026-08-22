import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hushh-ci-script-"));
}

function runScript(scriptPath: string, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...(options.args || [])], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });
}

function runScriptAsync(
  scriptPath: string,
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, ...(options.args || [])], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Timed out running ${scriptPath}`));
      }, 20_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
    }
  );
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withMockGitHubServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  callback: (baseUrl: string) => Promise<void>
) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind mock GitHub server.");
  }

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const validPrBody = `## Summary

- what changed: Added a 404 page and catch-all route for unknown URLs.
- why it changed: Users need a deterministic recovery path instead of a blank page.
- linked issue: #123
- acceptance criteria covered: Unknown routes show a useful page with navigation back to stable surfaces.
- risk area touched: ui
- reviewer focus: Verify the catch-all route remains last in the route table.

## Validation

- [x] npm run lint:ci
- [x] npm run env:check
- [x] npm run build:web
- ran: npm run lint:ci; npm run env:check; npm run build:web
- did not run: none - all relevant checks completed
- reviewer should verify: Check that unknown routes render the 404 page and links work.

## Notes

- deployment impact: none, browser route only.
- migration or env requirements: none.
- rollback or release notes: rollback by reverting the route addition.
`;

describe("CI workflow scripts", () => {
  it("loads local env vars when running the dev API server", () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
    );

    expect(rootPackage.scripts["dev:api"]).toContain("--env-file=.env.local");
    expect(rootPackage.scripts["dev:api"]).toContain("PORT=3000");
  });

  it("keeps Cloud Run runtime dependencies aligned with server API imports", () => {
    const gcpDataRuntime = fs.readFileSync(
      path.join(repoRoot, "api/shared/gcpDataRuntime.js"),
      "utf8"
    );
    const gcpServerClient = fs.readFileSync(
      path.join(repoRoot, "api/shared/gcpServerClient.js"),
      "utf8"
    );
    const runtimePackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package-server.json"), "utf8")
    );

    expect(gcpDataRuntime).toContain('from "@google-cloud/cloud-sql-connector"');
    expect(gcpDataRuntime).toContain('from "firebase-admin/app"');
    expect(gcpDataRuntime).toContain('from "pg"');
    expect(gcpDataRuntime).toContain('from "@google-cloud/storage"');
    expect(gcpServerClient).toContain("storageRuntime().bucket(bucket)");
    expect(runtimePackage.dependencies).toHaveProperty("@google-cloud/cloud-sql-connector");
    expect(runtimePackage.dependencies).toHaveProperty("@google-cloud/storage");
    expect(runtimePackage.dependencies).toHaveProperty("firebase-admin");
    expect(runtimePackage.dependencies).toHaveProperty("pg");

    const investorProfileRoute = fs.readFileSync(
      path.join(repoRoot, "api/generate-investor-profile.js"),
      "utf8"
    );

    if (investorProfileRoute.includes('from "@google/genai"')) {
      expect(runtimePackage.dependencies).toHaveProperty("@google/genai");
    }
  });

  it("runs the fail-closed GCP service package in PR and merge-queue CI", () => {
    const prWorkflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/ci.yml"),
      "utf8"
    );
    const queueWorkflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/queue-validation.yml"),
      "utf8"
    );
    const orchestrator = fs.readFileSync(
      path.join(repoRoot, "scripts/ci/orchestrate.sh"),
      "utf8"
    );
    const governance = fs.readFileSync(
      path.join(repoRoot, "docs/reference/operations/ci-governance.md"),
      "utf8"
    );

    for (const workflow of [prWorkflow, queueWorkflow]) {
      expect(workflow).toContain('SERVICE_NODE_VERSION: "22.23.2"');
      expect(workflow).toContain("gcp-service-foundation:");
      expect(workflow).toContain("name: GCP Service Foundation");
      expect(workflow).toContain(
        "cache-dependency-path: cloud-run/hushh-tech-app-services/package-lock.json"
      );
      expect(workflow).toContain("run: bash scripts/ci/orchestrate.sh service");
      expect(workflow).toContain("needs.gcp-service-foundation.result");
    }

    expect(orchestrator).toContain("cd cloud-run/hushh-tech-app-services");
    expect(orchestrator).toContain("npm ci --ignore-scripts");
    expect(orchestrator).toContain("npm run check");
    expect(orchestrator).toContain("npm audit --omit=dev");
    expect(governance).toContain("9. `GCP Service Foundation`");
  });

  it("runs the network-off Cloud SQL attestor on its exact Node runtime", () => {
    const prWorkflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/ci.yml"),
      "utf8"
    );
    const queueWorkflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/queue-validation.yml"),
      "utf8"
    );
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
    );
    const governance = fs.readFileSync(
      path.join(repoRoot, "docs/reference/operations/ci-governance.md"),
      "utf8"
    );

    expect(rootPackage.scripts["gcp:migration:check-cloudsql-attestor"]).toBe(
      "npm --prefix cloud-run/hushh-tech-cloudsql-attestor run check"
    );
    for (const workflow of [prWorkflow, queueWorkflow]) {
      expect(workflow).toContain('ATTESTOR_NODE_VERSION: "22.22.0"');
      expect(workflow).toContain("gcp-cloudsql-attestor:");
      expect(workflow).toContain("name: GCP Cloud SQL Attestor");
      expect(workflow).toContain(
        "cache-dependency-path: cloud-run/hushh-tech-cloudsql-attestor/package-lock.json"
      );
      expect(workflow).toContain(
        "run: npm --prefix cloud-run/hushh-tech-cloudsql-attestor ci"
      );
      expect(workflow).toContain("run: npm run gcp:migration:check-cloudsql-attestor");
      expect(workflow).toContain("needs.gcp-cloudsql-attestor.result");
    }
    expect(governance).toContain("10. `GCP Cloud SQL Attestor`");
  });

  it("registers each Hushh Research compatibility route once", () => {
    const runtime = fs.readFileSync(path.join(repoRoot, "server.js"), "utf8");

    expect(runtime.match(/app\.all\('\/api\/hushh-research\/config'/g)).toHaveLength(1);
    expect(runtime.match(/app\.all\('\/api\/hushh-research\/\*'/g)).toHaveLength(1);
  });

  it("accepts a conventional PR title and complete template metadata", () => {
    const tempDir = makeTempDir();
    const eventPath = path.join(tempDir, "event.json");
    const reportPath = path.join(tempDir, "pr-hygiene-report.json");

    writeJson(eventPath, {
      pull_request: {
        title: "feat(ui): add 404 not found page with navigation",
        body: validPrBody,
      },
    });

    const result = runScript(path.join(repoRoot, "scripts/ci/check-pr-hygiene.mjs"), {
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        PR_HYGIENE_REPORT_PATH: reportPath,
      },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("treats an empty successful PR-Agent review as valid when explicitly allowed", async () => {
    const tempDir = makeTempDir();
    const reportPath = path.join(tempDir, "signalkeeper-report.json");

    await withMockGitHubServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://mock.local");

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/issues/123/comments") {
        sendJson(response, 200, []);
        return;
      }

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/pulls/123/reviews") {
        sendJson(response, 200, []);
        return;
      }

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/pulls/123/comments") {
        sendJson(response, 200, []);
        return;
      }

      sendJson(response, 404, { message: `Unexpected ${request.method} ${requestUrl.pathname}` });
    }, async (baseUrl) => {
      const result = await runScriptAsync(path.join(repoRoot, "scripts/ci/verify-pr-agent-output.mjs"), {
        args: ["--allow-empty-success", `--report-path=${reportPath}`],
        env: {
          GITHUB_API_URL: baseUrl,
          GITHUB_TOKEN: "test-token",
          GITHUB_REPOSITORY: "hushh-labs/hushh_Tech_website",
          PR_AGENT_STARTED_AT: "2026-05-06T09:41:57Z",
          PR_NUMBER: "123",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Treating this as success");
      expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toMatchObject({
        allowEmptySuccess: true,
        counts: {
          visibleArtifacts: 0,
        },
      });
    });
  });

  it("keeps Signalkeeper Preflight green when GitHub blocks sticky comment writes", async () => {
    const tempDir = makeTempDir();
    const eventPath = path.join(tempDir, "event.json");
    const summaryPath = path.join(tempDir, "step-summary.md");
    const requests: string[] = [];

    writeJson(eventPath, {
      pull_request: {
        number: 123,
      },
    });

    await withMockGitHubServer(async (request, response) => {
      const requestUrl = new URL(request.url || "/", "http://mock.local");
      requests.push(`${request.method} ${requestUrl.pathname}`);

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/pulls/123") {
        sendJson(response, 200, {
          body: validPrBody,
          mergeable_state: "clean",
          head: {
            sha: "head-sha",
            label: "contributor:feat/ui",
            repo: { full_name: "contributor/hushh_Tech_website" },
          },
          base: {
            label: "hushh-labs:main",
            repo: { full_name: "hushh-labs/hushh_Tech_website" },
          },
        });
        return;
      }

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/pulls/123/files") {
        sendJson(response, 200, [{ filename: ".github/workflows/ci.yml" }]);
        return;
      }

      if (requestUrl.pathname === "/repos/hushh-labs/hushh_Tech_website/issues/123/comments") {
        if (request.method === "GET") {
          sendJson(response, 200, []);
          return;
        }

        if (request.method === "POST") {
          await readBody(request);
          sendJson(response, 403, {
            message: "Resource not accessible by integration",
            documentation_url: "https://docs.github.com/rest/issues/comments#create-an-issue-comment",
            status: "403",
          });
          return;
        }
      }

      if (
        requestUrl.pathname ===
        "/repos/hushh-labs/hushh_Tech_website/commits/head-sha/check-runs"
      ) {
        sendJson(response, 200, { check_runs: [] });
        return;
      }

      sendJson(response, 404, { message: `Unexpected ${request.method} ${requestUrl.pathname}` });
    }, async (baseUrl) => {
      const result = await runScriptAsync(
        path.join(repoRoot, "scripts/ci/publish-signalkeeper-preflight.mjs"),
        {
          env: {
            GITHUB_API_URL: baseUrl,
            GITHUB_TOKEN: "test-token",
            GITHUB_REPOSITORY: "hushh-labs/hushh_Tech_website",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            PR_VALIDATION_CHECKS: "PR Hygiene, CI Status Gate",
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("could not publish its sticky PR comment");
      expect(fs.readFileSync(summaryPath, "utf8")).toContain("# Signalkeeper Preflight");
      expect(requests).toContain("POST /repos/hushh-labs/hushh_Tech_website/issues/123/comments");
    });
  });
});
