import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  DEFAULT_RECOVERY_LIMITS,
  assertSafeCanonicalString,
  digestAttemptEvidence,
  digestCurrentEvidence,
  digestCurrentMetadata,
  digestCurrentSourceTree,
  encodeCanonicalRecord,
  inspectRecoverySnapshot,
  snapshotRecoveryTree,
} from "../scripts/ci/generate-supabase-current-function-bundle-evidence.mjs";

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
  it("builds only exact-project list and API download commands", () => {
    const listArgs = buildFunctionsListArgs();
    const downloadArgs = buildFunctionDownloadArgs({ slug: "get-secrets" });

    expect(assertReadOnlySupabaseCliArgs(listArgs)).toBe(listArgs);
    expect(assertReadOnlySupabaseCliArgs(downloadArgs)).toBe(downloadArgs);
    expect(listArgs).toContain(EXPECTED_PROJECT_REF);
    expect(downloadArgs).toContain("--use-api");
    expect(listArgs.slice(listArgs.indexOf("functions"), listArgs.indexOf("functions") + 2)).toEqual([
      "functions",
      "list",
    ]);
    expect(
      downloadArgs.slice(downloadArgs.indexOf("functions"), downloadArgs.indexOf("functions") + 2)
    ).toEqual(["functions", "download"]);
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
