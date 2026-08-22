import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CURRENT_EVIDENCE_LOCK,
  DEFAULT_REPORT_PATH,
  assertApprovedReportPath,
  validateCurrentFunctionBundleEvidence,
  writeApprovedReport,
} from "../scripts/ci/check-supabase-current-function-bundle-evidence.mjs";
import {
  EXPECTED_PROJECT_REF,
  assertMetadataStableAcrossCapture,
  assertReadOnlySupabaseCliArgs,
  buildFunctionDownloadArgs,
  buildFunctionsListArgs,
  classifyDownloadResponse,
  makeGlobalStartLimiter,
  normalizeLiveFunctionMetadata,
} from "../scripts/ci/capture-supabase-current-function-bundles.mjs";
import {
  BUNDLE_TRANSPORT,
  EDGE_RUNTIME_IMAGE,
  RAW_BODY_SURFACE,
  TRANSPORT_RECEIPT_FILE,
  __testing as localDockerCaptureTesting,
  assertDockerImageInspectResponse,
  assertDockerInfoResponse,
  assertExactDockerContextInspectArgs,
  assertExactDockerImageInspectArgs,
  assertExactDockerInfoArgs,
  assertLocalDockerContextResponse,
  buildDockerImageInspectArgs,
  buildDockerContextInspectArgs,
  buildDockerInfoArgs,
  captureLocalDockerCurrentFunctionBundles,
} from "../migration/scripts/ci/capture-supabase-current-function-bundles-local-docker.mjs";
import {
  DEFAULT_RECOVERY_LIMITS,
  assertSafeCanonicalString,
  digestAttemptEvidence,
  digestCurrentEvidence,
  digestCurrentMetadata,
  digestCurrentSourceTree,
  encodeCanonicalRecord,
  inspectRecoverySnapshot,
  sha256,
  snapshotRecoveryTree,
} from "../scripts/ci/generate-supabase-current-function-bundle-evidence.mjs";
import {
  buildLocalDockerCurrentFunctionBundleEvidence,
  inspectLocalDockerRecoverySnapshot,
} from "../migration/scripts/ci/generate-supabase-local-docker-function-bundle-evidence.mjs";

const root = process.cwd();
const manifestPath = path.join(root, "migration", "manifests", "supabase-retirement.v1.json");
const historicalEvidencePath = path.join(
  root,
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);
const currentEvidencePath = path.join(
  root,
  "migration",
  "evidence",
  "supabase-current-live-function-bundles.v2.json"
);
const manifestBytes = fs.readFileSync(manifestPath);
const historicalEvidenceBytes = fs.readFileSync(historicalEvidencePath);
const canonicalCheckerBytes = fs.readFileSync(
  path.join(root, "scripts", "ci", "check-supabase-retirement-manifest.mjs")
);
const historicalGeneratorBytes = fs.readFileSync(
  path.join(root, "scripts", "ci", "generate-supabase-live-function-bundle-evidence.mjs")
);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const historicalEvidence = JSON.parse(historicalEvidenceBytes.toString("utf8"));
const currentEvidence = JSON.parse(fs.readFileSync(currentEvidencePath, "utf8"));
const TEST_EDGE_RUNTIME_IMAGE = `public.ecr.aws/supabase/edge-runtime@sha256:${"a".repeat(64)}`;
const TEST_EDGE_RUNTIME_IMAGE_INSPECT = Object.freeze({
  Id: `sha256:${"b".repeat(64)}`,
  RepoDigests: [TEST_EDGE_RUNTIME_IMAGE],
  Os: "linux",
  Architecture: "amd64",
});

const clone = <T>(value: T): T => structuredClone(value);
const validate = (
  evidence: typeof currentEvidence,
  historical = historicalEvidence,
  historicalBytes = historicalEvidenceBytes,
  candidateManifest = manifest,
  candidateManifestBytes = manifestBytes
) =>
  validateCurrentFunctionBundleEvidence({
    manifest: candidateManifest,
    historicalEvidence: historical,
    evidence,
    manifestBytes: candidateManifestBytes,
    historicalEvidenceBytes: historicalBytes,
    canonicalCheckerBytes,
    historicalGeneratorBytes,
  });

const refreshSelfDigests = (evidence: typeof currentEvidence) => {
  evidence.current_metadata_digest.digest = digestCurrentMetadata(evidence.entries);
  evidence.canonical_source_tree.digest = digestCurrentSourceTree(evidence.entries);
  evidence.evidence_digest.digest = digestCurrentEvidence(evidence);
};

const makeSyntheticRecoverySnapshot = () => {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>(["", "supabase", "supabase/.temp"]);
  const linkedProject = Buffer.from(
    '{"ref":"ibsisfnjxeowvdtvgzff","name":"hushh-ai","organization_id":"rvbvlurmuppmecrarvma","organization_slug":"rvbvlurmuppmecrarvma"}'
  );
  const cliLatest = Buffer.from("v2.115.0");
  files.set("supabase/.temp/linked-project.json", linkedProject);
  files.set("supabase/.temp/cli-latest", cliLatest);
  const liveMetadata = currentEvidence.entries.map(
    (entry: {
      slug: string;
      function_id: string;
      status: string;
      current_version: number;
      verify_jwt: boolean;
      provider_bundle_digest: string | null;
    }) => ({
      slug: entry.slug,
      id: entry.function_id,
      status: entry.status,
      version: entry.current_version,
      verify_jwt: entry.verify_jwt,
      ezbr_sha256: entry.provider_bundle_digest,
    })
  );
  files.set("functions-list.json", Buffer.from(JSON.stringify(liveMetadata)));
  const outcomes = currentEvidence.entries.map(
    (entry: {
      slug: string;
      capture_status: string;
      capture_attempts: number;
    }) => {
      directories.add(entry.slug);
      directories.add(`${entry.slug}/supabase`);
      directories.add(`${entry.slug}/supabase/.temp`);
      files.set(`${entry.slug}/supabase/.temp/linked-project.json`, linkedProject);
      if (entry.capture_status === "EXTRACTED") {
        files.set(`${entry.slug}/supabase/.temp/cli-latest`, cliLatest);
        directories.add(`${entry.slug}/supabase/functions`);
        directories.add(`${entry.slug}/supabase/functions/${entry.slug}`);
        files.set(
          `${entry.slug}/supabase/functions/${entry.slug}/index.ts`,
          Buffer.from(`export const slug = ${JSON.stringify(entry.slug)};\n`)
        );
        files.set(
          `${entry.slug}.attempt-1.stdout`,
          Buffer.from(
            JSON.stringify({
              function_slugs: [entry.slug],
              project_ref: EXPECTED_PROJECT_REF,
              message: "Downloaded Edge Function source.",
            })
          )
        );
        files.set(`${entry.slug}.attempt-1.stderr`, Buffer.alloc(0));
        return {
          slug: entry.slug,
          status: "EXTRACTED",
          retryable: false,
          project_ref: EXPECTED_PROJECT_REF,
          attempts: 1,
        };
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        files.set(
          `${entry.slug}.attempt-${attempt}.stdout`,
          Buffer.from(
            JSON.stringify({
              _tag: "Error",
              error: {
                code: "FunctionsApiStatusError",
                message:
                  'Error status 500: {"message":"Failed to retrieve function bundle"}',
              },
            })
          )
        );
        files.set(`${entry.slug}.attempt-${attempt}.stderr`, Buffer.alloc(0));
      }
      return {
        slug: entry.slug,
        status: "BUNDLE_RETRIEVAL_FAILED",
        retryable: true,
        http_status: 500,
        provider_error_code: "FunctionsApiStatusError",
        failure_class: "FAILED_TO_RETRIEVE_FUNCTION_BUNDLE",
        attempts: 3,
      };
    }
  );
  files.set(
    "capture-receipt.json",
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        project_ref: EXPECTED_PROJECT_REF,
        tool: "supabase_cli",
        tool_version: "2.115.0",
        source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
        capture_started_at_utc: "2026-08-21T17:52:04.388Z",
        capture_completed_at_utc: "2026-08-21T18:03:38.344Z",
        active_functions: 112,
        outcomes,
      })
    )
  );
  return {
    files,
    directories,
    counts: {
      files: files.size,
      directories: directories.size,
      total_bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    },
  };
};

const withPrivateTempDirectory = (callback: (temporaryRoot: string) => void) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "current-function-bundle-test.")
  );
  fs.chmodSync(temporaryRoot, 0o700);
  try {
    callback(temporaryRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: false });
  }
};

describe("current Supabase function bundle evidence", () => {
  it("accepts the frozen read-only +43 snapshot", () => {
    const result = validate(clone(currentEvidence));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observed).toMatchObject({
      active_functions: 112,
      version_exact: 16,
      version_drifted: 96,
      version_uniform_drift_delta: 43,
      version_uniform_drift_count: 96,
      extracted_bundles: 96,
      bundle_retrieval_failed: 16,
      capture_attempts_total: 144,
      terminal_failures_after_max_attempts: 16,
      extracted_files: 445,
      extracted_bytes: 2842656,
      recovery_snapshot_digest:
        "b5621ff988f457f0226748da65770f21c1901a7b9c881f973476832722bbf3c4",
    });
    expect(currentEvidence.cutover_assessment).toEqual({
      status: "CUTOVER_BLOCKING_VERSION_DRIFT",
      frozen_snapshot_uniform_version_delta: 43,
      required_next_capture:
        "FREEZE_EDGE_FUNCTION_DEPLOYMENTS_THEN_REPEAT_FULL_READ_ONLY_112_FUNCTION_CAPTURE",
      metadata_end_check_status: "NOT_PERFORMED_IN_V2_BLOCKING",
      bundle_to_metadata_version_binding_status:
        "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
      source_revision_status: "NOT_PROVEN",
      source_revision: null,
      source_revision_reason:
        "SUPPORTED_LIST_AND_BODY_METADATA_DO_NOT_EXPOSE_A_DEPLOY_RUN_OR_GIT_SHA",
    });
    expect(currentEvidence.historical_comparison).toMatchObject({
      comparison_basis: "SAFE_DIGESTS_AND_COUNTS_ONLY",
      content_equivalence_status:
        "NOT_ASSERTED_BETWEEN_V1_AND_V2_CANONICALIZATION",
      historical_extracted_files: 445,
      historical_extracted_bytes: 2677504,
      current_extracted_files: 445,
      current_extracted_bytes: 2842656,
    });
  });

  it("rejects a coordinated ID forgery even when all self-digests are refreshed", () => {
    const evidence = clone(currentEvidence);
    evidence.entries[0].function_id = "00000000-0000-0000-0000-000000000000";
    refreshSelfDigests(evidence);

    const errors = validate(evidence).errors.join("\n");
    expect(errors).toContain("function_id changed");
    expect(errors).toContain("metadata entry digest changed from the lock");
    expect(errors).toContain("canonical evidence digest changed from the lock");
  });

  it("rejects a coordinated version-delta rewrite", () => {
    const evidence = clone(currentEvidence);
    for (const entry of evidence.entries) {
      if (entry.version_delta !== 0) {
        entry.current_version += 1;
        entry.version_delta += 1;
      }
    }
    evidence.observed_counts.version_uniform_drift_delta = 44;
    evidence.cutover_assessment.frozen_snapshot_uniform_version_delta = 44;
    refreshSelfDigests(evidence);

    const errors = validate(evidence).errors.join("\n");
    expect(errors).toContain("version_uniform_drift_delta changed");
    expect(errors).toContain("metadata entry digest changed from the lock");
  });

  it("rejects a bundle-tree rewrite with recomputed internal roots", () => {
    const evidence = clone(currentEvidence);
    const extracted = evidence.entries.find(
      (entry: { capture_status: string }) => entry.capture_status === "EXTRACTED"
    );
    extracted.bundle_evidence.canonical_digest = "a".repeat(64);
    refreshSelfDigests(evidence);

    const errors = validate(evidence).errors.join("\n");
    expect(errors).toContain("source-tree digest changed from the lock");
    expect(errors).toContain("canonical evidence digest changed from the lock");
  });

  it("rejects forged terminal retry evidence", () => {
    const evidence = clone(currentEvidence);
    const failed = evidence.entries.find(
      (entry: { capture_status: string }) =>
        entry.capture_status === "BUNDLE_RETRIEVAL_FAILED"
    );
    failed.retrieval_failure.attempt_response_classes = [
      "BUNDLE_RETRIEVAL_FAILED",
      "EXTRACTED",
      "BUNDLE_RETRIEVAL_FAILED",
    ];
    failed.retrieval_failure.attempt_evidence_digest = digestAttemptEvidence(
      failed.retrieval_failure.attempt_response_classes
    );
    evidence.evidence_digest.digest = digestCurrentEvidence(evidence);

    const errors = validate(evidence).errors.join("\n");
    expect(errors).toContain("attempt_response_classes changed");
    expect(errors).toContain("canonical evidence digest changed from the lock");
  });

  it("rejects historical-v1 substitution even with a coordinated binding rewrite", () => {
    const historical = clone(historicalEvidence);
    historical.entries[0].version += 1;
    const historicalBytes = Buffer.from(JSON.stringify(historical));
    const evidence = clone(currentEvidence);
    evidence.historical_binding.historical_entry_digest = historical.evidence_digest.digest;
    evidence.evidence_digest.digest = digestCurrentEvidence(evidence);

    const errors = validate(evidence, historical, historicalBytes).errors.join("\n");
    expect(errors).toContain("Historical v1 bundle evidence file digest changed");
  });

  it("rejects a coordinated manifest, historical artifact, and current binding identity forgery", () => {
    const forgedManifest = clone(manifest);
    forgedManifest.manifest_id = "coordinated-forgery";
    const forgedHistorical = clone(historicalEvidence);
    forgedHistorical.manifest_binding.manifest_id = "coordinated-forgery";
    const evidence = clone(currentEvidence);
    evidence.historical_binding.manifest_id = "coordinated-forgery";
    evidence.evidence_digest.digest = digestCurrentEvidence(evidence);

    const errors = validate(
      evidence,
      forgedHistorical,
      Buffer.from(JSON.stringify(forgedHistorical)),
      forgedManifest,
      Buffer.from(JSON.stringify(forgedManifest))
    ).errors.join("\n");
    expect(errors).toContain("Retirement manifest_id changed from the canonical identity");
    expect(errors).toContain("Retirement manifest file digest changed from the canonical lock");
    expect(errors).toContain("Historical v1 bundle evidence file digest changed from the canonical lock");
  });

  it("rejects extra raw output or source fields", () => {
    const evidence = clone(currentEvidence);
    evidence.entries[0].raw_source = "forbidden";

    expect(validate(evidence).errors.join("\n")).toContain(
      "Current function entry"
    );
  });

  it("contains only sanitized public evidence", () => {
    const serialized = JSON.stringify(currentEvidence);
    expect(serialized).not.toMatch(/\/private\//);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/Bearer\s/i);
    expect(serialized).not.toMatch(/sbp_[A-Za-z0-9]/);
    expect(serialized).not.toContain("raw_source");
    expect(currentEvidence.source_secret_scan).toMatchObject({
      tool: "gitleaks",
      tool_version: "8.24.2",
      status: "PASS",
      finding_count: 0,
    });
    expect(currentEvidence.historical_binding.manifest_file_digest).toBe(
      CURRENT_EVIDENCE_LOCK.manifest_file_digest
    );
    expect(currentEvidence.historical_binding.historical_evidence_file_digest).toBe(
      CURRENT_EVIDENCE_LOCK.historical_evidence_file_digest
    );
  });
});

describe("read-only Supabase function capture transport", () => {
  it("keeps the historical CLI read-only while the new path uses a pinned local image", () => {
    const listArgs = buildFunctionsListArgs();
    const historicalDownloadArgs = buildFunctionDownloadArgs({ slug: "get-secrets" });
    const dockerArgs = buildDockerInfoArgs();
    const dockerContextArgs = buildDockerContextInspectArgs();
    const imageArgs = buildDockerImageInspectArgs(TEST_EDGE_RUNTIME_IMAGE);

    expect(assertReadOnlySupabaseCliArgs(listArgs)).toBe(listArgs);
    expect(assertReadOnlySupabaseCliArgs(historicalDownloadArgs)).toBe(historicalDownloadArgs);
    expect(assertExactDockerInfoArgs(dockerArgs)).toBe(dockerArgs);
    expect(assertExactDockerContextInspectArgs(dockerContextArgs)).toBe(dockerContextArgs);
    expect(assertExactDockerImageInspectArgs(imageArgs, TEST_EDGE_RUNTIME_IMAGE)).toBe(imageArgs);
    expect(listArgs).toContain(EXPECTED_PROJECT_REF);
    expect(historicalDownloadArgs).toContain("--use-api");
    expect(historicalDownloadArgs).not.toContain("--use-docker");
    expect(listArgs.slice(listArgs.indexOf("functions"), listArgs.indexOf("functions") + 2)).toEqual([
      "functions",
      "list",
    ]);
    expect(
      historicalDownloadArgs.slice(
        historicalDownloadArgs.indexOf("functions"),
        historicalDownloadArgs.indexOf("functions") + 2
      )
    ).toEqual(["functions", "download"]);
    expect(imageArgs.at(-1)).toBe(TEST_EDGE_RUNTIME_IMAGE);
  });

  it("requires an exact local Docker daemon and digest-pinned extractor image", () => {
    expect(
      assertLocalDockerContextResponse({
        exitCode: 0,
        stdout: '"unix:///var/run/docker.sock"\n',
        stderr: "",
      })
    ).toBe("unix:///var/run/docker.sock");
    for (const endpoint of [
      "tcp://remote.example:2376",
      "ssh://builder",
      "npipe:////./pipe/docker",
      "unix:///tmp/../remote.sock",
      "unix:///tmp/%2e%2e/remote.sock",
    ]) {
      expect(() =>
        assertLocalDockerContextResponse({
          exitCode: 0,
          stdout: `${JSON.stringify(endpoint)}\n`,
          stderr: "",
        })
      ).toThrow("absolute local Unix socket");
    }
    expect(
      assertDockerInfoResponse({ exitCode: 0, stdout: '"28.3.3"\n', stderr: "" })
    ).toBe("28.3.3");
    expect(() =>
      assertDockerInfoResponse({ exitCode: 1, stdout: "", stderr: "daemon unavailable" })
    ).toThrow("Local Docker is required before any remote function body request");
    expect(() =>
      assertDockerInfoResponse({ exitCode: 0, stdout: '"unknown"', stderr: "" })
    ).toThrow("invalid server version");
    expect(() =>
      assertDockerInfoResponse({ exitCode: 0, stdout: '"28.3.3"', stderr: "warning" })
    ).toThrow("unexpected warning");
    expect(
      assertDockerImageInspectResponse(
        {
          exitCode: 0,
          stdout: `${JSON.stringify(TEST_EDGE_RUNTIME_IMAGE_INSPECT)}\n`,
          stderr: "",
        },
        TEST_EDGE_RUNTIME_IMAGE
      )
    ).toEqual({
      imageId: TEST_EDGE_RUNTIME_IMAGE_INSPECT.Id,
      imageOs: "linux",
      imageArchitecture: "amd64",
    });
    expect(() =>
      assertDockerImageInspectResponse(
        {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ...TEST_EDGE_RUNTIME_IMAGE_INSPECT,
            RepoDigests: [
              `public.ecr.aws/supabase/edge-runtime@sha256:${"d".repeat(64)}`,
            ],
          })}\n`,
          stderr: "",
        },
        TEST_EDGE_RUNTIME_IMAGE
      )
    ).toThrow("does not match");
    expect(() =>
      assertDockerImageInspectResponse(
        { exitCode: 1, stdout: "[]\n", stderr: "not found" },
        TEST_EDGE_RUNTIME_IMAGE
      )
    ).toThrow(
      "must exist locally before provider access"
    );
  });

  it("does not inherit unrelated secrets into local Docker child processes", () => {
    const previous = process.env.UNRELATED_PRIVATE_SECRET;
    process.env.UNRELATED_PRIVATE_SECRET = "must-not-reach-child";
    try {
      const childEnvironment = localDockerCaptureTesting.buildMinimalChildEnvironment();
      expect(childEnvironment).not.toHaveProperty("UNRELATED_PRIVATE_SECRET");
      expect(childEnvironment).not.toHaveProperty("SUPABASE_ACCESS_TOKEN");
      expect(childEnvironment).not.toHaveProperty("DOCKER_HOST");
      expect(childEnvironment).not.toHaveProperty("DOCKER_TLS_VERIFY");
      expect(childEnvironment).toHaveProperty("PATH");
    } finally {
      if (previous === undefined) delete process.env.UNRELATED_PRIVATE_SECRET;
      else process.env.UNRELATED_PRIVATE_SECRET = previous;
    }
  });

  it("stops before the first remote body request when local Docker is unavailable", async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "current-function-docker-gate.")
    );
    fs.chmodSync(recoveryRoot, 0o700);
    const metadataCommands: string[][] = [];
    let tokenReads = 0;
    let rawBodyReads = 0;
    let extractorCalls = 0;
    try {
      await expect(
        localDockerCaptureTesting.captureLocalDockerCore({
          manifest,
          recoveryRoot,
          edgeRuntimeImage: TEST_EDGE_RUNTIME_IMAGE,
          beforeEveryAttempt: async () => {},
          maxDownloadAttempts: 1,
          accessTokenProvider: () => {
            tokenReads += 1;
            return `sbp_${"a".repeat(24)}`;
          },
          metadataCommandRunner: async ({ args }: { args: string[] }) => {
            metadataCommands.push(args);
            throw new Error("metadata must not run");
          },
          dockerCommandRunner: async ({ args }: { args: string[] }) =>
            args[0] === "context"
              ? {
                  exitCode: 0,
                  signal: null,
                  stdout: '"unix:///var/run/docker.sock"\n',
                  stderr: "",
                }
              : {
                  exitCode: 1,
                  signal: null,
                  stdout: "",
                  stderr: "daemon unavailable",
                },
          rawBodyRunner: async () => {
            rawBodyReads += 1;
            throw new Error("raw body must not run");
          },
          dockerExtractor: async () => {
            extractorCalls += 1;
            throw new Error("extractor must not run");
          },
        })
      ).rejects.toThrow("Local Docker is required before any remote function body request");
      expect(metadataCommands).toHaveLength(0);
      expect(tokenReads).toBe(0);
      expect(rawBodyReads).toBe(0);
      expect(extractorCalls).toBe(0);
    } finally {
      fs.rmSync(recoveryRoot, { recursive: true, force: false });
    }
  });

  it("keeps production disabled before credentials or provider access until an image is reviewed", () => {
    expect(EDGE_RUNTIME_IMAGE).toBe("UNPROVISIONED");
    expect(() => captureLocalDockerCurrentFunctionBundles({ manifest })).toThrow(
      "Pinned edge-runtime image is unprovisioned"
    );
  });

  it("rejects Docker image drift after metadata but before the first raw body read", async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "current-function-image-drift.")
    );
    fs.chmodSync(recoveryRoot, 0o700);
    const liveMetadata = currentEvidence.entries.map(
      (entry: {
        slug: string;
        function_id: string;
        status: string;
        current_version: number;
        verify_jwt: boolean;
        provider_bundle_digest: string | null;
      }) => ({
        slug: entry.slug,
        id: entry.function_id,
        status: entry.status,
        version: entry.current_version,
        verify_jwt: entry.verify_jwt,
        ezbr_sha256: entry.provider_bundle_digest,
      })
    );
    let imageInspections = 0;
    let metadataReads = 0;
    let rawBodyReads = 0;
    try {
      await expect(
        localDockerCaptureTesting.captureLocalDockerCore({
          manifest,
          recoveryRoot,
          edgeRuntimeImage: TEST_EDGE_RUNTIME_IMAGE,
          accessToken: `sbp_${"e".repeat(24)}`,
          beforeEveryAttempt: async () => {},
          maxDownloadAttempts: 1,
          metadataCommandRunner: async ({ cwd }: { cwd: string }) => {
            metadataReads += 1;
            const bookkeepingRoot = path.join(cwd, "supabase", ".temp");
            fs.mkdirSync(bookkeepingRoot, { recursive: true, mode: 0o700 });
            fs.writeFileSync(
              path.join(bookkeepingRoot, "linked-project.json"),
              JSON.stringify({ ref: EXPECTED_PROJECT_REF }),
              { mode: 0o600, flag: "wx" }
            );
            fs.writeFileSync(path.join(bookkeepingRoot, "cli-latest"), "v2.115.0", {
              mode: 0o600,
              flag: "wx",
            });
            return {
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify(liveMetadata),
              stderr: "",
            };
          },
          dockerCommandRunner: async ({ args }: { args: string[] }) => {
            if (args[0] === "context") {
              return {
                exitCode: 0,
                signal: null,
                stdout: '"unix:///var/run/docker.sock"\n',
                stderr: "",
              };
            }
            if (args[0] === "info") {
              return { exitCode: 0, signal: null, stdout: '"29.7.2"\n', stderr: "" };
            }
            imageInspections += 1;
            return {
              exitCode: 0,
              signal: null,
              stdout: `${JSON.stringify({
                ...TEST_EDGE_RUNTIME_IMAGE_INSPECT,
                Id:
                  imageInspections === 1
                    ? TEST_EDGE_RUNTIME_IMAGE_INSPECT.Id
                    : `sha256:${"f".repeat(64)}`,
              })}\n`,
              stderr: "",
            };
          },
          rawBodyRunner: async () => {
            rawBodyReads += 1;
            throw new Error("raw body must not run");
          },
          dockerExtractor: async () => {
            throw new Error("extractor must not run");
          },
        })
      ).rejects.toThrow("Docker transport changed before a raw provider read");
      expect(metadataReads).toBe(1);
      expect(rawBodyReads).toBe(0);
      expect(imageInspections).toBe(2);
    } finally {
      fs.rmSync(recoveryRoot, { recursive: true, force: false });
    }
  });

  it("uses direct raw reads and the pinned local extractor for all 112 functions", async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "current-function-direct-body.")
    );
    fs.chmodSync(recoveryRoot, 0o700);
    const liveMetadata = currentEvidence.entries.map(
      (entry: {
        slug: string;
        function_id: string;
        status: string;
        current_version: number;
        verify_jwt: boolean;
        provider_bundle_digest: string | null;
      }) => ({
        slug: entry.slug,
        id: entry.function_id,
        status: entry.status,
        version: entry.current_version,
        verify_jwt: entry.verify_jwt,
        ezbr_sha256: entry.provider_bundle_digest,
      })
    );
    let metadataReads = 0;
    let rawBodyReads = 0;
    let extractorCalls = 0;
    try {
      const result = await localDockerCaptureTesting.captureLocalDockerCore({
        manifest,
        recoveryRoot,
        edgeRuntimeImage: TEST_EDGE_RUNTIME_IMAGE,
        accessToken: `sbp_${"b".repeat(24)}`,
        beforeEveryAttempt: async () => {},
        maxDownloadAttempts: 1,
        metadataCommandRunner: async ({ args, cwd }: { args: string[]; cwd: string }) => {
          expect(args).toEqual(buildFunctionsListArgs());
          expect(cwd).toBe(recoveryRoot);
          metadataReads += 1;
          const bookkeepingRoot = path.join(cwd, "supabase", ".temp");
          fs.mkdirSync(bookkeepingRoot, { recursive: true, mode: 0o700 });
          if (!fs.existsSync(path.join(bookkeepingRoot, "linked-project.json"))) {
            fs.writeFileSync(
              path.join(bookkeepingRoot, "linked-project.json"),
              JSON.stringify({ ref: EXPECTED_PROJECT_REF }),
              { mode: 0o600 }
            );
            fs.writeFileSync(path.join(bookkeepingRoot, "cli-latest"), "v2.115.0", {
              mode: 0o600,
            });
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(liveMetadata),
            stderr: "",
          };
        },
        dockerCommandRunner: async ({ args }: { args: string[] }) => {
          if (args[0] === "context") {
            return {
              exitCode: 0,
              signal: null,
              stdout: '"unix:///var/run/docker.sock"\n',
              stderr: "",
            };
          }
          if (args[0] === "info") {
            return { exitCode: 0, signal: null, stdout: '"29.7.2"\n', stderr: "" };
          }
          expect(args).toEqual(buildDockerImageInspectArgs(TEST_EDGE_RUNTIME_IMAGE));
          return {
            exitCode: 0,
            signal: null,
            stdout: `${JSON.stringify(TEST_EDGE_RUNTIME_IMAGE_INSPECT)}\n`,
            stderr: "",
          };
        },
        rawBodyRunner: async ({ slug, cwd }: { slug: string; cwd: string }) => {
          rawBodyReads += 1;
          const bytes = Buffer.from(`raw-eszip:${slug}`);
          const eszipPath = path.join(cwd, "supabase", ".temp", `output_${slug}.eszip`);
          fs.writeFileSync(eszipPath, bytes, { mode: 0o600, flag: "wx" });
          return { status: 200, eszipPath, bytes: bytes.length, sha256: sha256(bytes) };
        },
        dockerExtractor: async ({ slug, cwd }: { slug: string; cwd: string }) => {
          extractorCalls += 1;
          const sourceRoot = path.join(cwd, "supabase", "functions", slug);
          fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(sourceRoot, "index.ts"), `export const slug = "${slug}";\n`, {
            mode: 0o600,
            flag: "wx",
          });
        },
      });

      expect(metadataReads).toBe(2);
      expect(rawBodyReads).toBe(112);
      expect(extractorCalls).toBe(112);
      expect(result.outcomes).toHaveLength(112);
      expect(result.outcomes.every(({ status }: { status: string }) => status === "EXTRACTED")).toBe(
        true
      );
      expect(result.transportReceipt).toMatchObject({
        tool: "supabase_cli_metadata_plus_direct_management_api_body",
        bundle_transport: BUNDLE_TRANSPORT,
        raw_body_surface: RAW_BODY_SURFACE,
        docker_image: TEST_EDGE_RUNTIME_IMAGE,
        docker_image_id: TEST_EDGE_RUNTIME_IMAGE_INSPECT.Id,
        docker_image_os: "linux",
        docker_image_architecture: "amd64",
        download_attempts: 112,
      });
      expect(result.transportReceipt.raw_body_attempts).toHaveLength(112);
      expect(
        result.transportReceipt.raw_body_attempts.every(
          ({ status, sha256: digest }: { status: number; sha256: string }) =>
            status === 200 && /^[a-f0-9]{64}$/.test(digest)
        )
      ).toBe(true);
      expect(
        fs
          .readdirSync(recoveryRoot, { recursive: true })
          .some((entry) => String(entry).endsWith(".eszip"))
      ).toBe(false);
    } finally {
      fs.rmSync(recoveryRoot, { recursive: true, force: false });
    }
  });

  it("streams a raw ESZIP create-only and binds its exact byte digest", async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "current-function-raw-stream.")
    );
    fs.chmodSync(recoveryRoot, 0o700);
    fs.mkdirSync(path.join(recoveryRoot, "supabase", ".temp"), {
      recursive: true,
      mode: 0o700,
    });
    const rawBytes = Buffer.from("exact-eszip-bytes");
    const url = `https://api.supabase.com/v1/projects/${EXPECTED_PROJECT_REF}/functions/get-secrets/body`;
    const fetchMock = vi.fn(async () => ({
      url,
      redirected: false,
      status: 200,
      headers: new Headers({
        "content-type": "application/octet-stream",
        "content-length": String(rawBytes.length),
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(rawBytes.subarray(0, 5));
          controller.enqueue(rawBytes.subarray(5));
          controller.close();
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await localDockerCaptureTesting.runRawBodyFetch({
        slug: "get-secrets",
        projectRef: EXPECTED_PROJECT_REF,
        cwd: recoveryRoot,
        accessToken: `sbp_${"c".repeat(24)}`,
      });
      expect(result).toMatchObject({
        status: 200,
        bytes: rawBytes.length,
        sha256: sha256(rawBytes),
      });
      expect(fs.readFileSync(result.eszipPath)).toEqual(rawBytes);
      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          headers: expect.objectContaining({
            Accept: "application/octet-stream",
            "Accept-Encoding": "identity",
          }),
        })
      );
      fs.unlinkSync(result.eszipPath);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(recoveryRoot, { recursive: true, force: false });
    }
  });

  it("binds future capture receipts to raw ESZIP plus local Docker transport", () => {
    expect(BUNDLE_TRANSPORT).toBe(
      "DIRECT_MANAGEMENT_API_RAW_ESZIP_GET_LOCAL_DOCKER_UNBUNDLE_NO_CLI_FALLBACK"
    );
    expect(RAW_BODY_SURFACE).toContain("ACCEPT_APPLICATION_OCTET_STREAM");
  });

  it("accounts for and binds exact end metadata in local-Docker evidence", () => {
    const snapshot = makeSyntheticRecoverySnapshot();
    const startMetadata = JSON.parse(snapshot.files.get("functions-list.json")!.toString("utf8"));
    snapshot.files.set(
      "functions-list.json",
      Buffer.from(JSON.stringify(startMetadata, null, 2) + "\n")
    );
    snapshot.files.set(
      "functions-list-end.json",
      Buffer.from(JSON.stringify(startMetadata, null, 2) + "\n")
    );
    const receipt = JSON.parse(snapshot.files.get("capture-receipt.json")!.toString("utf8"));
    receipt.metadata_end_check = "MATCHED_EXACTLY";
    const captureReceiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
    snapshot.files.set(
      "capture-receipt.json",
      captureReceiptBytes
    );
    snapshot.files.set(
      TRANSPORT_RECEIPT_FILE,
      Buffer.from(
        JSON.stringify(
          {
            schema_version: 1,
            project_ref: EXPECTED_PROJECT_REF,
            tool: "supabase_cli_metadata_plus_direct_management_api_body",
            tool_version: "2.115.0",
            bundle_transport: BUNDLE_TRANSPORT,
            raw_body_surface: RAW_BODY_SURFACE,
            docker_image: TEST_EDGE_RUNTIME_IMAGE,
            docker_image_id: TEST_EDGE_RUNTIME_IMAGE_INSPECT.Id,
            docker_image_os: "linux",
            docker_image_architecture: "amd64",
            docker_context_class: "ABSOLUTE_LOCAL_UNIX_SOCKET",
            docker_context_endpoint_sha256: "a".repeat(64),
            docker_server_version: "29.7.2",
            download_attempts: receipt.outcomes.reduce(
              (sum: number, outcome: { attempts: number }) => sum + outcome.attempts,
              0
            ),
            raw_body_attempts: receipt.outcomes.flatMap(
              (outcome: { slug: string; status: string; attempts: number }) =>
                Array.from({ length: outcome.attempts }, (_, index) => {
                  const isLast = index === outcome.attempts - 1;
                  const status =
                    outcome.status === "EXTRACTED" && isLast
                      ? 200
                      : outcome.status === "STORE_NOT_FOUND"
                        ? 404
                        : 500;
                  return {
                    slug: outcome.slug,
                    status,
                    bytes: status === 200 ? 123 : 0,
                    sha256: status === 200 ? "c".repeat(64) : null,
                  };
                })
            ),
            capture_receipt_sha256: sha256(captureReceiptBytes),
            start_metadata_sha256: sha256(snapshot.files.get("functions-list.json")!),
            end_metadata_sha256: sha256(snapshot.files.get("functions-list-end.json")!),
          },
          null,
          2
        ) + "\n"
      )
    );
    snapshot.counts.files = snapshot.files.size;
    snapshot.counts.total_bytes = [...snapshot.files.values()].reduce(
      (sum, bytes) => sum + bytes.length,
      0
    );

    const inventory = inspectLocalDockerRecoverySnapshot({
      snapshot,
      manifest: clone(manifest),
    });
    const evidence = buildLocalDockerCurrentFunctionBundleEvidence({
      manifest: clone(manifest),
      historicalEvidence: clone(historicalEvidence),
      inventory,
      sourceSecretScan: {
        tool: "gitleaks",
        tool_version: "8.24.2",
        status: "PASS",
        finding_count: 0,
      },
      manifestBytes,
      historicalEvidenceBytes,
    });

    expect(inventory.normalizedEndMetadata).toEqual(inventory.normalizedMetadata);
    expect(evidence.capture.bundle_surface).toContain(
      "raw_eszip via direct_management_api_then_digest_pinned_local_edge_runtime_unbundle"
    );
    expect(evidence.capture).toMatchObject({
      tool: "supabase_cli_metadata_plus_direct_management_api_body",
      local_unbundle_image: TEST_EDGE_RUNTIME_IMAGE,
      local_unbundle_image_id: TEST_EDGE_RUNTIME_IMAGE_INSPECT.Id,
      local_unbundle_image_os: "linux",
      local_unbundle_image_architecture: "amd64",
    });
    expect(evidence.capture_integrity).toMatchObject({
      transport_receipt_digest_algorithm: "sha256",
      raw_body_attempts: 144,
    });
    expect(evidence.capture_integrity.transport_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.cutover_assessment).toMatchObject({
      metadata_end_check_status: "MATCHED_EXACTLY",
      bundle_to_metadata_version_binding_status: "BOUND_TO_STABLE_START_END_METADATA",
    });

    for (const mutation of [
      (value: Record<string, unknown>) => {
        value.raw_body_surface = "SERVER_MULTIPART_UNBUNDLE";
      },
      (value: Record<string, unknown>) => {
        value.docker_image = "UNPROVISIONED";
      },
      (value: Record<string, unknown>) => {
        const attempts = value.raw_body_attempts as Array<Record<string, unknown>>;
        attempts[0].slug = "forged-slug";
      },
      (value: Record<string, unknown>) => {
        delete value.docker_image_id;
      },
    ]) {
      const mutated = clone(snapshot);
      const transport = JSON.parse(
        Buffer.from(mutated.files.get(TRANSPORT_RECEIPT_FILE)!).toString("utf8")
      ) as Record<string, unknown>;
      mutation(transport);
      mutated.files.set(
        TRANSPORT_RECEIPT_FILE,
        Buffer.from(JSON.stringify(transport, null, 2) + "\n")
      );
      mutated.counts.total_bytes = [...mutated.files.values()].reduce(
        (sum, bytes) => sum + Buffer.from(bytes).length,
        0
      );
      expect(() =>
        inspectLocalDockerRecoverySnapshot({ snapshot: mutated, manifest: clone(manifest) })
      ).toThrow();
    }

    const drifted = clone(snapshot);
    const endMetadata = JSON.parse(
      Buffer.from(drifted.files.get("functions-list-end.json")!).toString("utf8")
    );
    endMetadata[0].version += 1;
    drifted.files.set(
      "functions-list-end.json",
      Buffer.from(JSON.stringify(endMetadata, null, 2) + "\n")
    );
    const driftedTransportReceipt = JSON.parse(
      Buffer.from(drifted.files.get(TRANSPORT_RECEIPT_FILE)!).toString("utf8")
    );
    driftedTransportReceipt.end_metadata_sha256 = sha256(
      drifted.files.get("functions-list-end.json")!
    );
    drifted.files.set(
      TRANSPORT_RECEIPT_FILE,
      Buffer.from(JSON.stringify(driftedTransportReceipt, null, 2) + "\n")
    );
    drifted.counts.total_bytes = [...drifted.files.values()].reduce(
      (sum, bytes) => sum + Buffer.from(bytes).length,
      0
    );
    expect(() =>
      inspectLocalDockerRecoverySnapshot({ snapshot: drifted, manifest: clone(manifest) })
    ).toThrow("metadata changed during bundle capture");
  });

  it("rejects any other project or write-shaped command", () => {
    expect(() => buildFunctionsListArgs({ projectRef: "other-project-ref" })).toThrow(
      "only permits project"
    );
    expect(() =>
      assertReadOnlySupabaseCliArgs([
        "--yes",
        "supabase@2.115.0",
        "functions",
        "deploy",
        "x",
        "--project-ref",
        EXPECTED_PROJECT_REF,
      ])
    ).toThrow("Only exact functions list and functions download commands are permitted");
  });

  it("normalizes the exact 112 live metadata records and rejects drift", () => {
    const liveMetadata = currentEvidence.entries.map(
      (entry: {
        slug: string;
        function_id: string;
        status: string;
        current_version: number;
        verify_jwt: boolean;
        provider_bundle_digest: string | null;
      }) => ({
        slug: entry.slug,
        id: entry.function_id,
        status: entry.status,
        version: entry.current_version,
        verify_jwt: entry.verify_jwt,
        ezbr_sha256: entry.provider_bundle_digest,
      })
    );
    const normalized = normalizeLiveFunctionMetadata({ manifest, liveMetadata });
    expect(normalized).toHaveLength(112);
    expect(normalized.filter((entry) => entry.version_delta === 43)).toHaveLength(96);
    expect(normalized.filter((entry) => entry.version_delta === 0)).toHaveLength(16);

    const wrongAuth = clone(liveMetadata);
    wrongAuth[0].verify_jwt = !wrongAuth[0].verify_jwt;
    expect(() => normalizeLiveFunctionMetadata({ manifest, liveMetadata: wrongAuth })).toThrow(
      "changed verify_jwt"
    );
    const duplicate = clone(liveMetadata);
    duplicate[1].slug = duplicate[0].slug;
    expect(() => normalizeLiveFunctionMetadata({ manifest, liveMetadata: duplicate })).toThrow(
      "duplicate function"
    );

    expect(
      assertMetadataStableAcrossCapture({
        startMetadata: normalized,
        endMetadata: clone(normalized),
      })
    ).toBe(true);
    const changedEnd = clone(normalized);
    changedEnd[0].current_version += 1;
    changedEnd[0].version_delta += 1;
    expect(() =>
      assertMetadataStableAcrossCapture({ startMetadata: normalized, endMetadata: changedEnd })
    ).toThrow("metadata changed during bundle capture");
  });

  it("classifies only allowlisted success, historical 404, and current 500 responses", () => {
    const success = classifyDownloadResponse({
      exitCode: 0,
      stdout: JSON.stringify({
        message: "Downloaded Edge Function source.",
        project_ref: EXPECTED_PROJECT_REF,
        function_slugs: ["stock-quotes"],
      }),
      stderr: "",
    });
    const store404 = classifyDownloadResponse({
      exitCode: 1,
      stdout: JSON.stringify({
        _tag: "Error",
        error: {
          code: "UnknownError",
          message: 'Error status 404: {"message":"Function store not found"}',
        },
      }),
      stderr: "",
    });
    const retrieval500 = classifyDownloadResponse({
      exitCode: 1,
      stdout: JSON.stringify({
        _tag: "Error",
        error: {
          code: "FunctionsApiStatusError",
          message: 'Error status 500: {"message":"Failed to retrieve function bundle"}',
        },
      }),
      stderr: "",
    });
    const unexpected = classifyDownloadResponse({
      exitCode: 1,
      stdout: JSON.stringify({ error: { message: "Bearer secret-value" } }),
      stderr: "nested secret-value",
    });

    expect(success).toMatchObject({ status: "EXTRACTED", retryable: false });
    expect(store404).toMatchObject({
      status: "STORE_NOT_FOUND",
      retryable: false,
      http_status: 404,
    });
    expect(retrieval500).toMatchObject({
      status: "BUNDLE_RETRIEVAL_FAILED",
      retryable: true,
      http_status: 500,
    });
    expect(unexpected).toEqual({
      status: "CAPTURE_FAILED",
      retryable: true,
      failure_class: "UNEXPECTED_CLI_FAILURE",
    });
    expect(JSON.stringify(unexpected)).not.toContain("secret-value");
  });

  it("uses one shared minimum-start limiter across attempts", async () => {
    let currentTime = 1_000;
    const sleeps: number[] = [];
    const limiter = makeGlobalStartLimiter({
      minimumStartIntervalMs: 1_100,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
    });

    await limiter();
    currentTime += 250;
    await limiter();
    currentTime += 1_100;
    await limiter();

    expect(sleeps).toEqual([850]);
  });
});

describe("current bundle canonicalization and recovery hardening", () => {
  it("uses collision-resistant length-prefixed records and rejects every control range", () => {
    expect(encodeCanonicalRecord(["ab", "c"]).equals(encodeCanonicalRecord(["a", "bc"]))).toBe(
      false
    );
    for (const value of ["line\nbreak", "nul\0byte", `del${String.fromCharCode(127)}`, `c1${String.fromCharCode(133)}`]) {
      expect(() => assertSafeCanonicalString(value)).toThrow("control character");
    }
    expect(() => assertSafeCanonicalString("e\u0301")).toThrow("NFC");
  });

  it("rejects unaccounted recovery entries and source under terminal failure roots", () => {
    const unaccounted = makeSyntheticRecoverySnapshot();
    unaccounted.files.set("unaccounted.txt", Buffer.from("x"));
    expect(() =>
      inspectRecoverySnapshot({ snapshot: unaccounted, manifest: clone(manifest) })
    ).toThrow("unaccounted file");

    const partialFailure = makeSyntheticRecoverySnapshot();
    const failed = currentEvidence.entries.find(
      (entry: { capture_status: string }) =>
        entry.capture_status === "BUNDLE_RETRIEVAL_FAILED"
    )!;
    partialFailure.directories.add(`${failed.slug}/supabase/functions`);
    partialFailure.directories.add(`${failed.slug}/supabase/functions/${failed.slug}`);
    partialFailure.files.set(
      `${failed.slug}/supabase/functions/${failed.slug}/index.ts`,
      Buffer.from("forbidden")
    );
    expect(() =>
      inspectRecoverySnapshot({ snapshot: partialFailure, manifest: clone(manifest) })
    ).toThrow("contains partial source");
  });

  it("enforces every global traversal cap before accepting the tree", () => {
    withPrivateTempDirectory((temporaryRoot) => {
      fs.writeFileSync(path.join(temporaryRoot, "one"), "12", { mode: 0o600 });
      fs.writeFileSync(path.join(temporaryRoot, "two"), "34", { mode: 0o600 });
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxFiles: 1 },
        })
      ).toThrow("global file cap");
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxFileBytes: 1 },
        })
      ).toThrow("oversized");
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxTotalBytes: 3 },
        })
      ).toThrow("global byte cap");
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxComponentBytes: 2 },
        })
      ).toThrow("component exceeds");
    });

    withPrivateTempDirectory((temporaryRoot) => {
      fs.mkdirSync(path.join(temporaryRoot, "aa"), { mode: 0o700 });
      fs.mkdirSync(path.join(temporaryRoot, "aa", "bb"), { mode: 0o700 });
      fs.writeFileSync(path.join(temporaryRoot, "aa", "bb", "cc"), "x", { mode: 0o600 });
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxDirectories: 2 },
        })
      ).toThrow("global directory cap");
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxDepth: 1 },
        })
      ).toThrow("global depth cap");
      expect(() =>
        snapshotRecoveryTree({
          recoveryRoot: temporaryRoot,
          limits: { ...DEFAULT_RECOVERY_LIMITS, maxRelativePathBytes: 4 },
        })
      ).toThrow("relative path exceeds");
    });
  });

  it("rejects symlinks, hard links, and group-writable recovery files", () => {
    withPrivateTempDirectory((temporaryRoot) => {
      fs.symlinkSync("missing", path.join(temporaryRoot, "link"));
      expect(() => snapshotRecoveryTree({ recoveryRoot: temporaryRoot })).toThrow(
        "forbidden symbolic link"
      );
    });
    withPrivateTempDirectory((temporaryRoot) => {
      const first = path.join(temporaryRoot, "first");
      fs.writeFileSync(first, "x", { mode: 0o600 });
      fs.linkSync(first, path.join(temporaryRoot, "second"));
      expect(() => snapshotRecoveryTree({ recoveryRoot: temporaryRoot })).toThrow(
        "exactly one hard link"
      );
    });
    withPrivateTempDirectory((temporaryRoot) => {
      const unsafe = path.join(temporaryRoot, "unsafe");
      fs.writeFileSync(unsafe, "x", { mode: 0o660 });
      fs.chmodSync(unsafe, 0o660);
      expect(() => snapshotRecoveryTree({ recoveryRoot: temporaryRoot })).toThrow(
        "unsafe mode"
      );
    });
  });
});

describe("current bundle checker report boundary", () => {
  it("permits only the exact create-only private report", () => {
    expect(() => assertApprovedReportPath(path.join(os.tmpdir(), "report.json"))).toThrow(
      "exact approved direct child"
    );
    const approved = path.resolve(DEFAULT_REPORT_PATH);
    const approvedParent = path.dirname(approved);
    fs.mkdirSync(approvedParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(approvedParent, 0o700);
    expect(fs.existsSync(approved)).toBe(false);
    try {
      writeApprovedReport({ reportPath: DEFAULT_REPORT_PATH, result: { valid: true } });
      const stat = fs.lstatSync(approved);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      expect(() =>
        writeApprovedReport({ reportPath: DEFAULT_REPORT_PATH, result: { valid: true } })
      ).toThrow("must not be overwritten");
    } finally {
      if (fs.existsSync(approved)) fs.unlinkSync(approved);
    }
  });
});
