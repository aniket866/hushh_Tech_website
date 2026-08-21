import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MANIFEST_PATH = path.join(
  "migration",
  "manifests",
  "supabase-retirement.v1.json"
);
export const DEFAULT_OUTPUT_PATH = path.join(
  "migration",
  "evidence",
  "supabase-live-function-bundles.v1.json"
);

const EXPECTED_PROJECT_REF = "ibsisfnjxeowvdtvgzff";
const EXTRACTED_MESSAGE = "Downloaded Edge Function source.";
const STORE_NOT_FOUND_MESSAGE =
  'Error status 404: {"message":"Function store not found"}';
const SUPPORTED_ESZIP_MIGRATION_WARNING =
  "unsupported supabase eszip version (expected [50, 46, 48], found Some([49, 46, 49])): will attempt migration";
const BUNDLE_DIGEST_ALGORITHM =
  "sha256_of_sha256_double_space_relative_path_lines_lc_all_c_v1";
const EVIDENCE_DIGEST_ALGORITHM =
  "sha256_of_canonical_function_bundle_evidence_lines_v1";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const listRegularFiles = (directory) => {
  const files = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Recovered bundle contains a forbidden symbolic link: ${entry.name}.`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      } else {
        throw new Error(`Recovered bundle contains an unsupported file type: ${entry.name}.`);
      }
    }
  };

  walk(directory);
  return files;
};

const buildBundleEvidence = ({ recoveryRoot, slug }) => {
  const functionRoot = path.join(recoveryRoot, slug, "supabase", "functions");
  assert(fs.existsSync(functionRoot), `Extracted function ${slug} has no functions directory.`);

  const files = listRegularFiles(functionRoot).map((absolutePath) => {
    const relativePath = path
      .relative(path.join(recoveryRoot, slug), absolutePath)
      .split(path.sep)
      .join("/");
    assert(
      relativePath.startsWith("supabase/functions/") && !relativePath.includes(".."),
      `Recovered function ${slug} has an invalid relative path.`
    );
    const contents = fs.readFileSync(absolutePath);
    return {
      relativePath,
      rootRelativePath: `${slug}/${relativePath}`,
      size: contents.length,
      digest: sha256(contents),
    };
  });

  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  assert(files.length > 0, `Extracted function ${slug} has no source files.`);

  const canonicalLines = files
    .map((file) => `${file.digest}  ${file.relativePath}\n`)
    .join("");

  return {
    publicEvidence: {
      digest_algorithm: BUNDLE_DIGEST_ALGORITHM,
      canonical_digest: sha256(canonicalLines),
      file_count: files.length,
      total_bytes: files.reduce((sum, file) => sum + file.size, 0),
    },
    files,
  };
};

const evidenceLine = (entry) => {
  const bundle = entry.bundle_evidence || {};
  const store = entry.store_lookup || {};
  return [
    entry.slug,
    entry.function_id,
    String(entry.version),
    String(entry.verify_jwt),
    entry.source_recovery_mode,
    entry.final_disposition,
    entry.migration_state,
    entry.capture_status,
    bundle.canonical_digest || "",
    String(bundle.file_count || 0),
    String(bundle.total_bytes || 0),
    String(store.http_status || ""),
    store.provider_error_code || "",
  ].join("\0") + "\n";
};

export const digestBundleEvidenceEntries = (entries) =>
  sha256([...entries].sort((left, right) => compareUtf8(left.slug, right.slug)).map(evidenceLine).join(""));

export const buildLiveFunctionBundleEvidence = ({
  manifest,
  recoveryRoot,
  captureToolVersion,
}) => {
  assert(manifest?.manifest_id, "Retirement manifest must declare manifest_id.");
  assert(Array.isArray(manifest?.functions), "Retirement manifest must contain functions.");
  assert(
    manifest.source_system?.project_ref === EXPECTED_PROJECT_REF,
    `Retirement manifest must target ${EXPECTED_PROJECT_REF}.`
  );
  assert(
    typeof captureToolVersion === "string" && /^\d+\.\d+\.\d+$/.test(captureToolVersion),
    "Capture tool version must be an exact semantic version."
  );

  const stdoutSlugs = fs
    .readdirSync(recoveryRoot)
    .filter((name) => name.endsWith(".stdout"))
    .map((name) => name.slice(0, -".stdout".length))
    .sort(compareUtf8);
  const stderrSlugs = fs
    .readdirSync(recoveryRoot)
    .filter((name) => name.endsWith(".stderr"))
    .map((name) => name.slice(0, -".stderr".length))
    .sort(compareUtf8);
  const manifestSlugs = manifest.functions
    .map((entry) => entry.source?.slug)
    .sort(compareUtf8);

  assert(
    JSON.stringify(stdoutSlugs) === JSON.stringify(manifestSlugs),
    "Recovery stdout files must match the exact manifest slug set."
  );
  assert(
    JSON.stringify(stderrSlugs) === JSON.stringify(manifestSlugs),
    "Recovery stderr files must match the exact manifest slug set."
  );

  const allExtractedFiles = [];
  const entries = manifest.functions
    .map((manifestEntry) => {
      const slug = manifestEntry.source.slug;
      const stdout = readJson(path.join(recoveryRoot, `${slug}.stdout`));
      const stderr = fs.readFileSync(path.join(recoveryRoot, `${slug}.stderr`), "utf8");
      const stderrLines = stderr.trimEnd().split("\n");
      assert(
        stderrLines[0] === `Downloading function: ${slug}`,
        `Recovery stderr does not bind to ${slug}.`
      );

      const common = {
        slug,
        function_id: manifestEntry.source.function_id,
        version: manifestEntry.source.version,
        verify_jwt: manifestEntry.source.verify_jwt,
        source_recovery_mode: manifestEntry.source_recovery.mode,
        final_disposition: manifestEntry.final_disposition,
        migration_state: manifestEntry.migration_state,
      };

      if (stdout.message === EXTRACTED_MESSAGE) {
        assert(
          stdout.project_ref === EXPECTED_PROJECT_REF &&
            JSON.stringify(stdout.function_slugs) === JSON.stringify([slug]),
          `Downloaded bundle response does not bind to ${slug}.`
        );
        assert(
          stderrLines.at(-1) ===
            `Eszip extracted successfully inside path /home/deno/${slug}` &&
            (stderrLines.length === 2 ||
              (stderrLines.length === 3 &&
                stderrLines[1] === SUPPORTED_ESZIP_MIGRATION_WARNING)),
          `Downloaded bundle for ${slug} has unexpected extractor diagnostics.`
        );
        const bundle = buildBundleEvidence({ recoveryRoot, slug });
        allExtractedFiles.push(...bundle.files);
        return {
          ...common,
          capture_status: "EXTRACTED",
          bundle_evidence: bundle.publicEvidence,
        };
      }

      assert(
        stdout._tag === "Error" &&
          stdout.error?.code === "UnknownError" &&
          stdout.error?.message === STORE_NOT_FOUND_MESSAGE &&
          stderrLines.length === 1,
        `Recovery output for ${slug} is neither extracted nor the exact store-not-found response.`
      );
      const functionRoot = path.join(recoveryRoot, slug, "supabase", "functions");
      assert(
        !fs.existsSync(functionRoot),
        `Store-not-found function ${slug} unexpectedly contains an extracted source directory.`
      );
      return {
        ...common,
        capture_status: "STORE_NOT_FOUND",
        store_lookup: {
          http_status: 404,
          provider_error_code: "UnknownError",
        },
      };
    })
    .sort((left, right) => compareUtf8(left.slug, right.slug));

  allExtractedFiles.sort((left, right) =>
    compareUtf8(left.rootRelativePath, right.rootRelativePath)
  );
  const canonicalSourceTreeLines = allExtractedFiles
    .map((file) => `${file.digest}  ${file.rootRelativePath}\n`)
    .join("");
  const extractedEntries = entries.filter((entry) => entry.capture_status === "EXTRACTED");
  const notFoundEntries = entries.filter(
    (entry) => entry.capture_status === "STORE_NOT_FOUND"
  );

  return {
    schema_version: 1,
    evidence_id: "hushh-tech-supabase-live-function-bundles",
    manifest_binding: {
      manifest_id: manifest.manifest_id,
      manifest_schema_version: manifest.schema_version,
      source_project_ref: EXPECTED_PROJECT_REF,
    },
    capture: {
      tool: "supabase_cli",
      tool_version: captureToolVersion,
      method: "functions_download_current_bundle_extractor_read_only",
      source_write_mode: "READ_ONLY_NO_DEPLOYMENT",
    },
    sanitization: {
      recovered_source_content_committed: false,
      stdout_or_stderr_committed: false,
      secret_or_token_values_committed: false,
      temporary_absolute_paths_committed: false,
      public_evidence: "per_slug_content_tree_digest_file_count_and_byte_count_only",
    },
    expected_counts: {
      active_functions: entries.length,
      extracted_bundles: extractedEntries.length,
      store_not_found: notFoundEntries.length,
      extracted_files: allExtractedFiles.length,
      extracted_bytes: allExtractedFiles.reduce((sum, file) => sum + file.size, 0),
    },
    canonical_source_tree: {
      digest_algorithm: BUNDLE_DIGEST_ALGORITHM,
      digest: sha256(canonicalSourceTreeLines),
    },
    evidence_digest: {
      digest_algorithm: EVIDENCE_DIGEST_ALGORITHM,
      digest: digestBundleEvidenceEntries(entries),
    },
    entries,
  };
};

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const manifestPath = parseArg("--manifest") || DEFAULT_MANIFEST_PATH;
  const recoveryRoot = parseArg("--recovery-root");
  const outputPath = parseArg("--output") || DEFAULT_OUTPUT_PATH;
  const captureToolVersion = parseArg("--capture-tool-version");

  if (!recoveryRoot) {
    throw new Error("--recovery-root is required and is never written into the evidence artifact.");
  }

  const manifest = readJson(path.resolve(manifestPath));
  const evidence = buildLiveFunctionBundleEvidence({
    manifest,
    recoveryRoot: path.resolve(recoveryRoot),
    captureToolVersion,
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    `Generated ${outputPath}: ${evidence.expected_counts.active_functions} functions, ` +
      `${evidence.expected_counts.extracted_bundles} extracted, ` +
      `${evidence.expected_counts.store_not_found} store-not-found.`
  );
}
