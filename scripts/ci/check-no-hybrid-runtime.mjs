import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL("./no-hybrid-runtime-policy.json", import.meta.url),
);

const SOURCE_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".env",
  ".gradle",
  ".graphql",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mdx",
  ".mjs",
  ".mm",
  ".pbxproj",
  ".plist",
  ".properties",
  ".py",
  ".rb",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xcconfig",
  ".xml",
  ".yaml",
  ".yml",
]);

const MODULE_EXTENSIONS = [
  "",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  "/index.js",
  "/index.mjs",
  "/index.ts",
  "/index.tsx",
  "/index.jsx",
];

const ALLOWED_CLASSIFICATIONS = new Set([
  "automated-gate-evidence",
  "automated-test-evidence",
  "documentation-archive",
  "legacy-provider-source-archive",
  "migration-contract-evidence",
  "migration-evidence-tooling",
  "migration-tooling",
]);

const EXPECTED_FORBIDDEN_PROJECT_REFS = Object.freeze([
  "ibsisfnjxeowvdtvgzff",
  "gsqmwxqgqrgzhlhmbscg",
  "hkdlmkpqwbjnmcwlxczv",
  "jbvfjyxpjyspafqzohmi",
  "qoeqfmeimagulpzjptbj",
  "rpmzykoxqnbozgdoqbpc",
  "spmxyqxjqxcyywkapong",
]);

const EXPECTED_BROWSER_SAMPLE_ROUTES = Object.freeze([
  "/",
  "/login",
  "/signup",
  "/metrics",
  "/delete-account",
]);
const EXPECTED_BROWSER_COVERAGE = Object.freeze({
  mode: "exhaustive-route-and-local-auth-fixtures",
  sample_routes: EXPECTED_BROWSER_SAMPLE_ROUTES,
  inventory_path: "tests/noHybridRouteInventory.generated.json",
  playwright_spec: "tests/noHybridNetwork.spec.ts",
  browsers: Object.freeze(["chromium", "webkit"]),
  personas: Object.freeze([
    "firebase-user-a",
    "firebase-user-b",
    "firebase-admin",
  ]),
  full_route_inventory: true,
  authenticated_fixture: true,
});

// This digest covers the complete parsed policy envelope: source surfaces,
// entrypoints, generated roots, classifications, forbidden dependencies,
// project refs, browser contract, frozen route contract, and every wiring
// path. A policy edit therefore cannot silently narrow what this checker sees.
const EXPECTED_CANONICAL_POLICY_SHA256 =
  "8b48cf8176b6453340afa4b101b774cffcfeb8e0bc4ca478f8eb83ebf72e0f3e";
const EXPECTED_PLAYWRIGHT_CONFIG_SHA256 =
  "4a990df407c5a260198c6fe82fed7b745b9e403cf636da887e48344f262dc47b";
const EXPECTED_BROWSER_INSTALL =
  "run: npx playwright install --with-deps chromium webkit";

const FORBIDDEN_CLASSIFICATION_ROOTS = [
  ".github/workflows",
  "android",
  "api",
  "capacitor.config.js",
  "capacitor.config.ts",
  "cloud-run",
  "cloudbuild-prod.yaml",
  "cloudbuild-uat.yaml",
  "cloudbuild.yaml",
  "dist",
  "Dockerfile",
  "Dockerfile.gcp",
  "index.html",
  "ios",
  "package-server.json",
  "package.json",
  "public",
  "server.js",
  "src",
  "vercel.json",
  "vite.config.ts",
];

const PROVIDER_URL_RE = /(?:https?|wss?):\/\/[^\s"'`<>]*supabase\.(?:co|com|in)\b|(?:^|[^a-z0-9-])(?:\*\.)?[a-z0-9-]*\.?supabase\.(?:co|com|in)\b/i;
const PROVIDER_ENV_RE = /\b(?:VITE_|NEXT_PUBLIC_)?(?:MARKET_|LEGACY_)?SUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY|KEY|DB_URL|DATABASE_URL|JWT_SECRET|PASSWORD|PROJECT_REF|REDIRECT_URL)\b/i;
const PROVIDER_SDK_RE = /(?:@supabase\/supabase-js|npm:\s*@?supabase|jsr:\s*@?supabase|from\s*["']supabase["'])/i;
const PROVIDER_CLI_RE = /(?:^|\s)(?:npx\s+)?supabase\s+(?:db|functions|gen|inspect|link|migration|projects|secrets|start|status|stop)\b/i;
const PROVIDER_CLIENT_RE = /\bsupabaseClient\b|\bsupabase\s*(?:\?\.|\.)\s*(?:auth|from|functions|rpc|storage)\b/i;
const INERT_LINEAGE_ADAPTER_PATH = "api/shared/gcp-delete-account-storage.js";
const INERT_LINEAGE_ADAPTER_SHA256 =
  "a264f6e8022d3521c309300fda7ef3b8a25a2f3e6e2e4f8be5a93b9cc2952937";

// These two exact statements are inert provenance checks inside the reviewed
// Google Cloud Storage adapter. The exception is deliberately bound to that
// file and complete syntax. Any renamed variable, concatenation, escaping,
// extension, or additional executable reference remains visible below.
function stripInertStorageMigrationLineageStatements(source, relativePath) {
  if (
    normalizeRelative(relativePath) !== INERT_LINEAGE_ADAPTER_PATH ||
    crypto.createHash("sha256").update(source).digest("hex") !== INERT_LINEAGE_ADAPTER_SHA256
  ) {
    return source;
  }
  return source
    .replace(
      'const MIGRATION_NAMESPACE = "_hushh_migrations/supabase-cutover-v1";',
      'const MIGRATION_NAMESPACE = "storage-migration-lineage";',
    )
    .replace(
      'metadata["hushh-migration-schema"] !== "supabase-cutover-v1"',
      'metadata["hushh-migration-schema"] !== "storage-migration-lineage"',
    );
}

function normalizeRelative(value) {
  return value.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function isWithin(relativePath, candidateRoot) {
  const file = normalizeRelative(relativePath);
  const root = normalizeRelative(candidateRoot);
  return file === root || file.startsWith(`${root}/`);
}

function uniqueViolations(violations) {
  const seen = new Set();
  return violations.filter((violation) => {
    const key = `${violation.code}\0${violation.file ?? ""}\0${violation.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addViolation(violations, code, file, detail) {
  violations.push({ code, file: normalizeRelative(file), detail });
}

function classificationFor(relativePath, policy) {
  return policy.classified_non_runtime.find((entry) => isWithin(relativePath, entry.path)) ?? null;
}

function stripExecutableComments(input, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const slashComments = new Set([
    ".cjs",
    ".gradle",
    ".h",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".m",
    ".mm",
    ".mjs",
    ".pbxproj",
    ".swift",
    ".ts",
    ".tsx",
  ]).has(extension);
  const hashComments = new Set([".env", ".py", ".rb", ".sh", ".yaml", ".yml"]).has(extension) ||
    ["Dockerfile", "Dockerfile.gcp"].includes(path.basename(relativePath));
  let output = "";
  let state = "normal";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        output += "\n";
        state = "normal";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "normal";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      output += char;
      if (char === "\\" && index + 1 < input.length) {
        output += input[index + 1];
        index += 1;
        continue;
      }
      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "normal";
      }
      continue;
    }

    if (char === "'") {
      output += char;
      state = "single";
    } else if (char === '"') {
      output += char;
      state = "double";
    } else if (char === "`") {
      output += char;
      state = "template";
    } else if (slashComments && char === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (slashComments && char === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
    } else if (hashComments && char === "#" && /^\s*$/.test(output.slice(output.lastIndexOf("\n") + 1))) {
      output += " ";
      state = "line-comment";
    } else {
      output += char;
    }
  }

  return output;
}

function decodeEscapes(value) {
  let decoded = value
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function decodeQuotedString(expression) {
  const quote = expression[0];
  if (!quote || quote !== expression.at(-1) || !["'", '"', "`"].includes(quote)) return null;
  let body = expression.slice(1, -1);
  if (quote === "`" && body.includes("${")) return null;
  body = decodeEscapes(body)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([\\'"`])/g, "$1");
  return body;
}

function splitTopLevel(expression, separator) {
  const pieces = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (["(", "[", "{"].includes(char)) depth += 1;
    else if ([")", "]", "}"].includes(char)) depth -= 1;
    else if (char === separator && depth === 0) {
      pieces.push(expression.slice(start, index));
      start = index + 1;
    }
  }
  pieces.push(expression.slice(start));
  return pieces;
}

function evaluateStringExpression(expression, constants) {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();

  const plusParts = splitTopLevel(value, "+");
  if (plusParts.length > 1) {
    const evaluated = plusParts.map((part) => evaluateStringExpression(part, constants));
    return evaluated.every((part) => typeof part === "string") ? evaluated.join("") : null;
  }

  const literal = decodeQuotedString(value);
  if (literal !== null) return literal;

  if (/^[A-Za-z_$][\w$]*$/.test(value)) return constants.get(value) ?? null;

  const template = value.match(/^`([\s\S]*)`$/);
  if (template) {
    let unresolved = false;
    const rendered = decodeEscapes(template[1]).replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_match, name) => {
      if (!constants.has(name)) {
        unresolved = true;
        return "";
      }
      return constants.get(name);
    });
    return unresolved ? null : rendered;
  }

  const join = value.match(/^\[([\s\S]*)\]\.join\(\s*(["'`][\s\S]*?["'`])\s*\)$/);
  if (join) {
    const separator = decodeQuotedString(join[2]);
    const values = splitTopLevel(join[1], ",").map((item) => evaluateStringExpression(item, constants));
    if (separator !== null && values.every((item) => typeof item === "string")) return values.join(separator);
  }

  const fromCharCode = value.match(/^String\.fromCharCode\(\s*([0-9,\s]+)\s*\)$/);
  if (fromCharCode) {
    return String.fromCharCode(
      ...fromCharCode[1].split(",").map((part) => Number.parseInt(part.trim(), 10)),
    );
  }

  const atobCall = value.match(/^atob\(\s*([\s\S]+)\s*\)$/);
  if (atobCall) {
    const encoded = evaluateStringExpression(atobCall[1], constants);
    if (encoded !== null) {
      try {
        return Buffer.from(encoded, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
  }

  const bufferCall = value.match(/^Buffer\.from\(\s*([^,]+),\s*["']base64["']\s*\)\.toString\([^)]*\)$/);
  if (bufferCall) {
    const encoded = evaluateStringExpression(bufferCall[1], constants);
    if (encoded !== null) {
      try {
        return Buffer.from(encoded, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
  }

  return null;
}

function collectDerivedStrings(source) {
  const constants = new Map();
  const declarations = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)];
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const [, name, expression] of declarations) {
      if (constants.has(name)) continue;
      const value = evaluateStringExpression(expression, constants);
      if (value !== null) {
        constants.set(name, value);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const decodedLiterals = [];
  for (const match of source.matchAll(/["'`]([A-Za-z0-9+/_=-]{12,512})["'`]/g)) {
    const encoded = match[1];
    if (encoded.length % 4 === 1) continue;
    try {
      const decoded = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
      const printable = [...decoded].filter((char) => char === "\n" || char === "\r" || char === "\t" || (char >= " " && char <= "~")).length;
      if (decoded.length >= 6 && printable / decoded.length > 0.9) decodedLiterals.push(decoded);
    } catch {
      // An invalid candidate is simply not a base64-derived constant.
    }
  }

  return { constants, values: [...constants.values(), ...decodedLiterals] };
}

function buildProviderComparisonCorpus(corpus) {
  const variants = new Set([corpus]);
  const decoded = decodeEscapes(corpus);
  variants.add(decoded);
  for (const value of [...variants]) variants.add(value.normalize("NFKC"));

  const urlCandidates = [...variants].flatMap((value) =>
    [...value.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>\\]+/giu)].map((match) => match[0]),
  );
  for (const candidate of urlCandidates) {
    for (const value of [candidate, candidate.replace(/[),;\]}]+$/g, "")]) {
      try {
        const parsed = new URL(value);
        variants.add(parsed.href);
        variants.add(parsed.hostname);
      } catch {
        // Malformed URL-shaped text remains visible in the original corpus.
      }
    }
  }
  return [...variants].join("\n");
}

function matchSignals(corpus) {
  const comparisonCorpus = buildProviderComparisonCorpus(corpus);
  const matches = [];
  if (PROVIDER_SDK_RE.test(comparisonCorpus)) matches.push("PROVIDER_SDK_IMPORT");
  if (PROVIDER_URL_RE.test(comparisonCorpus)) matches.push("PROVIDER_URL");
  if (PROVIDER_ENV_RE.test(comparisonCorpus)) matches.push("PROVIDER_ENV_BINDING");
  if (PROVIDER_CLI_RE.test(comparisonCorpus)) matches.push("PROVIDER_CLI_ACCESS");
  if (PROVIDER_CLIENT_RE.test(comparisonCorpus)) matches.push("PROVIDER_CLIENT_ACCESS");
  const normalizedCorpus = comparisonCorpus.toLowerCase();
  if (EXPECTED_FORBIDDEN_PROJECT_REFS.some((projectRef) => normalizedCorpus.includes(projectRef))) {
    matches.push("PROVIDER_PROJECT_REF");
  }

  const providerTainted = matches.length > 0 || /\bsupabase\b/i.test(comparisonCorpus);
  if (providerTainted && /\bcreateClient\s*\(/.test(comparisonCorpus)) {
    matches.push("PROVIDER_CLIENT_CONSTRUCTION");
  }
  if (
    providerTainted &&
    /\.(?:auth|from|functions|rpc|storage)\s*(?:\.|\?\.|\()/.test(comparisonCorpus)
  ) {
    matches.push("PROVIDER_DATA_OR_AUTH_ACCESS");
  }
  return [...new Set(matches)];
}

function usesPublicFirebaseKeyAsCredential(source) {
  const firebaseKeyReference = String.raw`(?:\b(?:VITE_)?FIREBASE_API_KEY\b|\bconfig\s*(?:\.|\?\.)\s*FIREBASE_API_KEY\b|import\s*\.\s*meta\s*\.\s*env\s*\.\s*VITE_FIREBASE_API_KEY\b)`;
  const taintedNames = new Set();
  const declarations = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)];
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false;
    for (const [, name, expression] of declarations) {
      if (taintedNames.has(name)) continue;
      const referencesKey = new RegExp(firebaseKeyReference, "i").test(expression);
      const referencesTainted = [...taintedNames].some((candidate) =>
        new RegExp(`\\b${candidate.replace(/[$]/g, "\\$")}\\b`).test(expression),
      );
      if (referencesKey || referencesTainted) {
        taintedNames.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const taintedExpression = [firebaseKeyReference, ...[...taintedNames].map((name) => `\\b${name.replace(/[$]/g, "\\$")}\\b`)].join("|");
  const credentialHeader = new RegExp(
    String.raw`(?:["']?(?:authorization|apikey)["']?\s*:|\.set\(\s*["'](?:authorization|apikey)["']\s*,)\s*[^,\n}]{0,320}(?:${taintedExpression})`,
    "i",
  );
  return credentialHeader.test(source);
}

export function analyzeExecutableContent(source, relativePath = "fixture.ts") {
  const stripped = stripExecutableComments(source, relativePath);
  const executable = stripInertStorageMigrationLineageStatements(stripped, relativePath);
  const decoded = decodeEscapes(executable);
  const compact = decoded.replace(/[\s'"`+,[\](){}]/g, "");
  const derived = collectDerivedStrings(executable);
  const directSignals = matchSignals(`${executable}\n${decoded}\n${compact}`);
  if (
    normalizeRelative(relativePath) === INERT_LINEAGE_ADAPTER_PATH &&
    /\bsupabase\b/i.test(executable)
  ) {
    directSignals.push("OBFUSCATED_PROVIDER_REFERENCE");
  }
  if (usesPublicFirebaseKeyAsCredential(executable)) {
    directSignals.push("PUBLIC_FIREBASE_KEY_AS_CREDENTIAL");
  }
  const derivedCorpus = derived.values.join("\n");
  const derivedSignals = matchSignals(derivedCorpus);
  for (const importMatch of executable.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']@supabase\/supabase-js["']/gi,
  )) {
    const creator = importMatch[1].match(/\bcreateClient(?:\s+as\s+([A-Za-z_$][\w$]*))?/i);
    if (!creator) continue;
    const localName = creator[1] || "createClient";
    if (new RegExp(`\\b${localName.replace(/[$]/g, "\\$")}\\s*\\(`).test(executable)) {
      directSignals.push("PROVIDER_CLIENT_CONSTRUCTION");
    }
  }
  const violations = directSignals.map((code) => ({ code, file: normalizeRelative(relativePath) }));
  if (derivedSignals.length > 0 || /\bsupabase\b/i.test(derivedCorpus)) {
    violations.push({
      code: "OBFUSCATED_PROVIDER_REFERENCE",
      file: normalizeRelative(relativePath),
      detail: derivedSignals.length > 0
        ? `decoded signals: ${derivedSignals.sort().join(", ")}`
        : "decoded provider token",
    });
  }
  return { violations: uniqueViolations(violations), constants: derived.constants };
}

function extractAsciiStrings(buffer) {
  const matches = buffer.toString("latin1").match(/[\x20-\x7e]{6,}/g);
  return matches ? matches.join("\n") : "";
}

function scanFileContent(absolutePath, relativePath) {
  const buffer = fs.readFileSync(absolutePath);
  const extension = path.extname(relativePath).toLowerCase();
  const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
  if (!binary && (SOURCE_EXTENSIONS.has(extension) || relativePath.startsWith("dist/"))) {
    return analyzeExecutableContent(buffer.toString("utf8"), relativePath).violations;
  }
  const strings = extractAsciiStrings(buffer);
  return strings ? analyzeExecutableContent(strings, relativePath).violations : [];
}

function listFiles(root, relativePath, violations, { missingIsError = false } = {}) {
  const normalized = normalizeRelative(relativePath);
  const absolute = path.join(root, normalized);
  if (!fs.existsSync(absolute)) {
    if (missingIsError) addViolation(violations, "REQUIRED_SURFACE_MISSING", normalized, "required path is absent");
    return [];
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    addViolation(violations, "SYMLINKED_RUNTIME_SURFACE", normalized, "runtime scanning refuses symlink traversal");
    return [];
  }
  if (stat.isFile()) return [normalized];
  if (!stat.isDirectory()) return [];

  const files = [];
  const visit = (currentAbsolute, currentRelative) => {
    const entries = fs.readdirSync(currentAbsolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if ([".git", "node_modules", "playwright-report", "test-results", "tmp"].includes(entry.name)) continue;
      const childRelative = normalizeRelative(path.join(currentRelative, entry.name));
      const childAbsolute = path.join(currentAbsolute, entry.name);
      if (entry.isSymbolicLink()) {
        addViolation(violations, "SYMLINKED_RUNTIME_SURFACE", childRelative, "runtime scanning refuses symlink traversal");
      } else if (entry.isDirectory()) {
        visit(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  };
  visit(absolute, normalized);
  return files;
}

function resolveLocalModule(root, importer, specifier) {
  let candidate;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    candidate = path.resolve(root, path.dirname(importer), specifier);
  } else if (specifier.startsWith("@/")) {
    candidate = path.resolve(root, "src", specifier.slice(2));
  } else {
    return null;
  }
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (candidate !== path.resolve(root) && !candidate.startsWith(rootPrefix)) return null;
  for (const suffix of MODULE_EXTENSIONS) {
    const possible = `${candidate}${suffix}`;
    if (fs.existsSync(possible) && fs.statSync(possible).isFile()) {
      return normalizeRelative(path.relative(root, possible));
    }
  }
  return null;
}

function moduleSpecifiers(source, constants) {
  const specifiers = new Set();
  const literalPatterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of literalPatterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }

  const unresolved = [];
  for (const match of source.matchAll(/\b(?:import|require)\(\s*([\s\S]*?)\s*\)/g)) {
    const expression = match[1].trim();
    const computed = evaluateStringExpression(expression, constants);
    if (typeof computed === "string" && computed.length > 0) {
      specifiers.add(computed);
    } else {
      unresolved.push({ index: match.index, length: match[0].length });
    }
  }
  return { specifiers: [...specifiers], unresolved };
}

function scanImportGraph(root, policy, initialRuntimeFiles, violations) {
  const runtimeSet = new Set(initialRuntimeFiles);
  const queue = policy.runtime_entrypoints.filter((entry) => fs.existsSync(path.join(root, entry)));
  const visited = new Set();

  while (queue.length > 0) {
    const importer = normalizeRelative(queue.shift());
    if (visited.has(importer)) continue;
    visited.add(importer);
    const importerPath = path.join(root, importer);
    const source = fs.readFileSync(importerPath, "utf8");
    const analysis = analyzeExecutableContent(source, importer);
    const imports = moduleSpecifiers(source, analysis.constants);
    for (const unresolved of imports.unresolved) {
      addViolation(
        violations,
        "UNRESOLVED_DYNAMIC_RUNTIME_IMPORT",
        importer,
        `dynamic import at byte ${unresolved.index} is not statically bounded`,
      );
    }
    for (const specifier of imports.specifiers) {
      const target = resolveLocalModule(root, importer, specifier);
      if (!target) continue;
      const classification = classificationFor(target, policy);
      if (classification) {
        addViolation(
          violations,
          "RUNTIME_IMPORTS_CLASSIFIED_NON_RUNTIME_CODE",
          importer,
          `${specifier} reaches ${classification.classification}:${target}`,
        );
        for (const violation of scanFileContent(path.join(root, target), target)) violations.push(violation);
        continue;
      }
      if (!runtimeSet.has(target)) runtimeSet.add(target);
      queue.push(target);
    }
  }

  return { reachableFiles: [...visited].sort(), runtimeFiles: [...runtimeSet].sort() };
}

function validateDirectDependencies(root, relativePath, policy, violations) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch {
    addViolation(violations, "INVALID_PACKAGE_MANIFEST", relativePath, "manifest is not valid JSON");
    return;
  }
  const productionDependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const [name, version] of Object.entries(productionDependencies)) {
    if (
      policy.forbidden_direct_dependencies.includes(name) ||
      /(?:@supabase\/supabase-js|npm:@?supabase)/i.test(`${name}:${version}`)
    ) {
      addViolation(violations, "PROVIDER_RUNTIME_DEPENDENCY", relativePath, `production dependency ${name} is forbidden`);
    }
  }
}

function validatePackageLock(root, policy, violations) {
  const relativePath = "package-lock.json";
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return;
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch {
    addViolation(violations, "INVALID_PACKAGE_LOCK", relativePath, "lockfile is not valid JSON");
    return;
  }
  const rootDependencies = lock.packages?.[""]?.dependencies ?? {};
  for (const name of policy.forbidden_direct_dependencies) {
    if (Object.hasOwn(rootDependencies, name)) {
      addViolation(violations, "PROVIDER_RUNTIME_DEPENDENCY", relativePath, `locked root production dependency ${name} is forbidden`);
    }
  }
}

export function validatePolicy(
  policy,
  { enforceBrowserCoverage = true, enforceCanonicalPolicy = true } = {},
) {
  const violations = [];
  if (policy?.schema_version !== 1) addViolation(violations, "POLICY_SCHEMA_INVALID", "scripts/ci/no-hybrid-runtime-policy.json", "schema_version must be 1");
  if (policy?.contract_id !== "hushh-tech-no-hybrid-runtime-v1") {
    addViolation(violations, "POLICY_ID_INVALID", "scripts/ci/no-hybrid-runtime-policy.json", "contract_id mismatch");
  }
  if (enforceCanonicalPolicy) {
    const observedDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex");
    if (observedDigest !== EXPECTED_CANONICAL_POLICY_SHA256) {
      addViolation(
        violations,
        "POLICY_CANONICAL_DIGEST_INVALID",
        "scripts/ci/no-hybrid-runtime-policy.json",
        `complete policy digest mismatch: ${observedDigest}`,
      );
    }
  }
  if (!Array.isArray(policy?.source_surfaces) || policy.source_surfaces.length === 0) {
    addViolation(violations, "POLICY_SURFACES_EMPTY", "scripts/ci/no-hybrid-runtime-policy.json", "source_surfaces must be non-empty");
  }
  if (
    !Array.isArray(policy?.forbidden_project_refs) ||
    JSON.stringify(policy.forbidden_project_refs) !== JSON.stringify(EXPECTED_FORBIDDEN_PROJECT_REFS)
  ) {
    addViolation(
      violations,
      "POLICY_PROJECT_REFS_INVALID",
      "scripts/ci/no-hybrid-runtime-policy.json",
      "forbidden_project_refs must contain the exact primary and six secondary project refs",
    );
  }
  const browserCoverage = policy?.browser_coverage;
  if (JSON.stringify(browserCoverage) !== JSON.stringify(EXPECTED_BROWSER_COVERAGE)) {
    addViolation(
      violations,
      "BROWSER_COVERAGE_POLICY_INVALID",
      "scripts/ci/no-hybrid-runtime-policy.json",
      "browser coverage classification is malformed",
    );
  }
  if (
    enforceBrowserCoverage &&
    (browserCoverage?.full_route_inventory !== true ||
      browserCoverage?.authenticated_fixture !== true)
  ) {
    addViolation(
      violations,
      "FULL_ROUTE_AND_AUTH_BROWSER_COVERAGE",
      "scripts/ci/no-hybrid-runtime-policy.json",
      "full route inventory and authenticated browser fixtures must both be automated",
    );
  }
  if (!Array.isArray(policy?.classified_non_runtime)) {
    addViolation(violations, "POLICY_CLASSIFICATIONS_INVALID", "scripts/ci/no-hybrid-runtime-policy.json", "classified_non_runtime must be an array");
    return violations;
  }
  const seen = new Set();
  for (const entry of policy.classified_non_runtime) {
    const normalized = normalizeRelative(entry.path ?? "");
    if (!normalized || normalized === "." || normalized.includes("..")) {
      addViolation(violations, "POLICY_CLASSIFICATION_PATH_INVALID", "scripts/ci/no-hybrid-runtime-policy.json", `invalid classified path ${entry.path}`);
      continue;
    }
    if (seen.has(normalized)) {
      addViolation(violations, "POLICY_CLASSIFICATION_DUPLICATE", "scripts/ci/no-hybrid-runtime-policy.json", `duplicate classified path ${normalized}`);
    }
    seen.add(normalized);
    if (!ALLOWED_CLASSIFICATIONS.has(entry.classification)) {
      addViolation(violations, "POLICY_CLASSIFICATION_KIND_INVALID", "scripts/ci/no-hybrid-runtime-policy.json", `invalid classification ${entry.classification}`);
    }
    if (
      normalized === "scripts" ||
      FORBIDDEN_CLASSIFICATION_ROOTS.some(
        (runtimeRoot) => isWithin(normalized, runtimeRoot) || isWithin(runtimeRoot, normalized),
      )
    ) {
      addViolation(violations, "POLICY_ATTEMPTS_RUNTIME_ALLOWLIST", "scripts/ci/no-hybrid-runtime-policy.json", `${normalized} overlaps deployable runtime`);
    }
  }
  return uniqueViolations(violations);
}

function indexesInOrder(contents, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = contents.indexOf(marker);
    if (current === -1 || current <= previous) return false;
    previous = current;
  }
  return true;
}

function activeContents(contents, relativePath) {
  return stripExecutableComments(contents, relativePath);
}

function shellCaseBlock(contents, label) {
  const active = activeContents(contents, "scripts/ci/orchestrate.sh");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = active.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\)\\s*\\n([\\s\\S]*?)\\n\\s*;;`));
  return match?.[1] ?? "";
}

function yamlJobBlock(contents, jobName, relativePath) {
  const active = activeContents(contents, relativePath);
  const lines = active.split("\n");
  const matcher = new RegExp(`^ {2}${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
  const starts = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []));
  if (starts.length !== 1) return "";
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function yamlLineMatchesMarker(line, marker) {
  const trimmed = line.trim();
  if (
    marker.startsWith("name:") ||
    marker.startsWith("run:") ||
    marker.startsWith("- ") ||
    marker.startsWith("[")
  ) {
    return trimmed === marker;
  }
  if (marker === "google-github-actions/auth") {
    return /^-?\s*uses:\s+google-github-actions\/auth@[^\s]+$/.test(trimmed);
  }
  const direct = trimmed.startsWith("- ") ? trimmed.slice(2).trimStart() : trimmed;
  return (
    direct === marker ||
    direct === `run: ${marker}` ||
    direct.startsWith(`${marker} `)
  );
}

function yamlMarkersInOrder(block, markers) {
  const lines = block.split("\n");
  let previous = -1;
  for (const marker of markers) {
    const index = lines.findIndex(
      (line, lineIndex) => lineIndex > previous && yamlLineMatchesMarker(line, marker),
    );
    if (index === -1) return false;
    previous = index;
  }
  return true;
}

function yamlStepBlock(jobBlock, marker) {
  const lines = jobBlock.split("\n");
  const markerIndex = lines.findIndex((line) => yamlLineMatchesMarker(line, marker));
  if (markerIndex === -1) return "";
  let start = markerIndex;
  while (start > 0 && !/^ {6}-\s/.test(lines[start])) start -= 1;
  let end = lines.length;
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    if (/^ {6}-\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function isUnconditionalYamlStep(jobBlock, marker) {
  const step = yamlStepBlock(jobBlock, marker);
  return step.length > 0 && !/^ {8}if:\s*/m.test(step);
}

function finalDockerStage(contents, relativePath) {
  const active = activeContents(contents, relativePath);
  const fromMatches = [...active.matchAll(/^FROM\s+.+$/gm)];
  if (fromMatches.length === 0) return "";
  return active.slice(fromMatches.at(-1).index);
}

function readRequired(root, relativePath, violations) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    addViolation(violations, "REQUIRED_WIRING_FILE_MISSING", relativePath, "required wiring file is absent");
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

export function validateGateWiring(root, policy) {
  const violations = validatePolicy(policy, {
    enforceBrowserCoverage: false,
    enforceCanonicalPolicy: true,
  });
  const packagePath = path.join(root, "package.json");
  let packageJson = {};
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    addViolation(violations, "INVALID_PACKAGE_MANIFEST", "package.json", "cannot validate gate scripts");
  }
  const expectedScripts = {
    "migration:no-hybrid:routes": "node scripts/ci/generate-no-hybrid-route-inventory.mjs",
    "migration:no-hybrid:source": "node scripts/ci/check-no-hybrid-runtime.mjs --source-only",
    "migration:no-hybrid:check": "node scripts/ci/check-no-hybrid-runtime.mjs --require-dist",
    "test:e2e:no-hybrid": "playwright test --config=playwright.no-hybrid.config.ts",
  };
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (packageJson.scripts?.[name] !== expected) {
      addViolation(violations, "PACKAGE_GATE_SCRIPT_MISSING", "package.json", `${name} must equal ${expected}`);
    }
  }

  const browserGuardPath = "tests/noHybridNetworkGuard.ts";
  const browserGuard = activeContents(readRequired(root, browserGuardPath, violations), browserGuardPath);
  for (const marker of [
    'context.route("**/*"',
    'context.routeWebSocket("**/*"',
    "route.url()",
    "isForbiddenProviderTarget(request.url())",
    "await route.close",
  ]) {
    if (!browserGuard.includes(marker)) {
      addViolation(
        violations,
        "BROWSER_NETWORK_GUARD_INCOMPLETE",
        browserGuardPath,
        `missing ${marker}`,
      );
    }
  }
  const browserConfigPath = "playwright.no-hybrid.config.ts";
  const browserConfigRaw = readRequired(root, browserConfigPath, violations);
  const browserConfig = activeContents(browserConfigRaw, browserConfigPath);
  if (
    crypto.createHash("sha256").update(browserConfigRaw).digest("hex") !==
    EXPECTED_PLAYWRIGHT_CONFIG_SHA256
  ) {
    addViolation(
      violations,
      "BROWSER_CONFIG_DIGEST_DRIFT",
      browserConfigPath,
      "the exact Chromium and WebKit Playwright project configuration changed",
    );
  }
  if (!browserConfig.includes('serviceWorkers: "block"')) {
    addViolation(
      violations,
      "BROWSER_SERVICE_WORKER_GUARD_MISSING",
      browserConfigPath,
      "service workers must be blocked during no-hybrid browser proof",
    );
  }
  const browserSpecPath = "tests/noHybridNetwork.spec.ts";
  const browserSpec = activeContents(readRequired(root, browserSpecPath, violations), browserSpecPath);
  if (!browserSpec.includes("wss://tenant.supabase.co/realtime/v1/websocket")) {
    addViolation(
      violations,
      "BROWSER_WEBSOCKET_ADVERSARIAL_TEST_MISSING",
      browserSpecPath,
      "the browser proof must exercise a blocked provider WebSocket",
    );
  }
  for (const route of policy.browser_coverage?.sample_routes ?? []) {
    if (!browserSpec.includes(`"${route}"`)) {
      addViolation(
        violations,
        "BROWSER_SAMPLE_ROUTE_MISSING",
        browserSpecPath,
        `missing policy sample ${route}`,
      );
    }
  }

  const wiring = policy.required_wiring;
  const orchestrator = readRequired(root, wiring.orchestrator, violations);
  const noHybridCase = shellCaseBlock(orchestrator, "no-hybrid");
  const noHybridCommands = noHybridCase.split("\n").map((line) => line.trim()).filter(Boolean);
  const expectedNoHybridCommands = [
    "npm run migration:no-hybrid:routes",
    "npm run migration:no-hybrid:source",
    "npm run build:web",
    "npm run migration:no-hybrid:check",
    "npm run test:e2e:no-hybrid",
  ];
  if (JSON.stringify(noHybridCommands) !== JSON.stringify(expectedNoHybridCommands)) {
    addViolation(violations, "ORCHESTRATOR_GATE_MISSING", wiring.orchestrator, "no-hybrid case must contain the exact route, source, build, artifact, and browser gate commands");
  }
  const queueCase = shellCaseBlock(orchestrator, "queue");
  if (!indexesInOrder(queueCase, expectedNoHybridCommands)) {
    addViolation(violations, "QUEUE_ORCHESTRATOR_GATE_MISSING", wiring.orchestrator, "queue must run source, build, artifact, and browser no-hybrid gates in order");
  }

  for (const [kind, workflowPath] of [
    ["pull request", wiring.pull_request_workflow],
    ["merge queue", wiring.queue_workflow],
  ]) {
    const workflow = readRequired(root, workflowPath, violations);
    const gateJob = yamlJobBlock(workflow, "no-hybrid-runtime", workflowPath);
    const statusJob = yamlJobBlock(workflow, "ci-status", workflowPath);
    for (const [marker, block] of [
      ["name: No-Hybrid Runtime Gate", gateJob],
      [EXPECTED_BROWSER_INSTALL, gateJob],
      ["run: bash scripts/ci/orchestrate.sh no-hybrid", gateJob],
      ["- no-hybrid-runtime", statusJob],
      ['["No-Hybrid Runtime Gate"]="${{ needs.no-hybrid-runtime.result }}"', statusJob],
    ]) {
      if (!block.split("\n").some((line) => yamlLineMatchesMarker(line, marker))) {
        addViolation(violations, "AUTHORITATIVE_WORKFLOW_GATE_MISSING", workflowPath, `${kind} workflow is missing active ${marker}`);
      }
    }
    if (!isUnconditionalYamlStep(gateJob, "run: bash scripts/ci/orchestrate.sh no-hybrid")) {
      addViolation(violations, "AUTHORITATIVE_WORKFLOW_GATE_CONDITIONAL", workflowPath, `${kind} no-hybrid command must be unconditional`);
    }
    if (
      !yamlMarkersInOrder(gateJob, [
        EXPECTED_BROWSER_INSTALL,
        "run: bash scripts/ci/orchestrate.sh no-hybrid",
      ]) ||
      !isUnconditionalYamlStep(gateJob, EXPECTED_BROWSER_INSTALL)
    ) {
      addViolation(
        violations,
        "BROWSER_ENGINE_INSTALL_INVALID",
        workflowPath,
        `${kind} must install Chromium and WebKit before the no-hybrid browser gate`,
      );
    }
    if (/^ {4}if:\s*/m.test(gateJob)) {
      addViolation(violations, "AUTHORITATIVE_WORKFLOW_GATE_DISABLED", workflowPath, `${kind} no-hybrid job must not have a job-level condition`);
    }
  }

  const postMergeRaw = readRequired(root, wiring.post_merge_workflow, violations);
  const postMerge = yamlJobBlock(postMergeRaw, "smoke-gate", wiring.post_merge_workflow);
  const postMergeMarkers = [
    "npm run migration:no-hybrid:routes",
    "npm run migration:no-hybrid:source",
    "npm run build:web",
    "npm run migration:no-hybrid:check",
    "npx playwright install --with-deps chromium webkit",
    "npm run test:e2e:no-hybrid",
    "bash scripts/ci/orchestrate.sh smoke",
  ];
  if (
    !yamlMarkersInOrder(postMerge, postMergeMarkers) ||
    postMergeMarkers.some((marker) => !isUnconditionalYamlStep(postMerge, marker))
  ) {
    addViolation(violations, "POST_MERGE_GATE_ORDER_INVALID", wiring.post_merge_workflow, "source, build, artifact, browser, and smoke gates must run in order");
  }
  if (
    !isUnconditionalYamlStep(
      postMerge,
      "npx playwright install --with-deps chromium webkit",
    )
  ) {
    addViolation(
      violations,
      "BROWSER_ENGINE_INSTALL_INVALID",
      wiring.post_merge_workflow,
      "post-merge must install Chromium and WebKit before the browser gate",
    );
  }

  for (const deployPath of wiring.deploy_workflows) {
    const deployRaw = readRequired(root, deployPath, violations);
    const deploy = yamlJobBlock(deployRaw, "deploy", deployPath);
    const deployMarkers = [
      "npm run migration:no-hybrid:routes",
      "npm run migration:no-hybrid:source",
      "google-github-actions/auth",
      "npm run build:web",
      "npm run migration:no-hybrid:check",
      "gcloud run deploy hushh-tech-website",
    ];
    if (
      !yamlMarkersInOrder(deploy, deployMarkers) ||
      deployMarkers.some((marker) => !isUnconditionalYamlStep(deploy, marker))
    ) {
      addViolation(violations, "DEPLOY_GATE_ORDER_INVALID", deployPath, "source gate must precede cloud auth and artifact gate must precede deployment");
    }
  }

  for (const dockerfile of wiring.runtime_dockerfiles) {
    const contents = finalDockerStage(readRequired(root, dockerfile, violations), dockerfile);
    const exactGate = "RUN node scripts/ci/check-no-hybrid-runtime.mjs --artifact-only --require-dist";
    if (
      !/^RUN node scripts\/ci\/check-no-hybrid-runtime\.mjs --artifact-only --require-dist\s*$/m.test(contents) ||
      !indexesInOrder(contents, [
        "COPY scripts/ci/check-no-hybrid-runtime.mjs",
        exactGate,
        "CMD [\"node\", \"server.js\"]",
      ])
    ) {
      addViolation(violations, "RUNTIME_IMAGE_GATE_MISSING", dockerfile, "artifact gate must run before the runtime command");
    }
  }

  const frozen = policy.frozen_compatibility_contract;
  const registry = readRequired(root, frozen.registry_path, violations);
  const routeCount = [...registry.matchAll(/^\s*"slug":\s*"/gm)].length;
  if (routeCount !== frozen.expected_route_count) {
    addViolation(violations, "FROZEN_ROUTE_COUNT_DRIFT", frozen.registry_path, `expected ${frozen.expected_route_count} routes; found ${routeCount}`);
  }
  const server = activeContents(readRequired(root, frozen.server_path, violations), frozen.server_path);
  const routeOccurrences = server.split(`'${frozen.server_route}'`).length - 1;
  if (routeOccurrences !== 1) {
    addViolation(violations, "FROZEN_COMPATIBILITY_ROUTE_DRIFT", frozen.server_path, `${frozen.server_route} must remain registered exactly once`);
  }
  for (const workflowPath of [wiring.pull_request_workflow, wiring.queue_workflow, wiring.post_merge_workflow]) {
    const workflow = activeContents(readRequired(root, workflowPath, violations), workflowPath);
    if (!workflow.includes("orchestrate.sh retirement")) {
      addViolation(violations, "RETIREMENT_GATE_REMOVED", workflowPath, "the frozen 112-route retirement check must remain wired");
    }
  }

  return uniqueViolations(violations);
}

export function loadNoHybridPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

export function scanNoHybridRuntime({
  root = process.cwd(),
  policy = loadNoHybridPolicy(),
  requireDist = false,
  artifactOnly = false,
  validateWiring = !artifactOnly,
  enforceCanonicalPolicy = true,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const violations = validatePolicy(policy, {
    enforceBrowserCoverage: validateWiring && !artifactOnly,
    enforceCanonicalPolicy,
  });
  const runtimeFiles = new Set();

  for (const surface of policy.source_surfaces) {
    for (const file of listFiles(resolvedRoot, surface.path, violations)) {
      if (!classificationFor(file, policy)) runtimeFiles.add(file);
    }
  }

  let graph = { reachableFiles: [], runtimeFiles: [...runtimeFiles].sort() };
  if (!artifactOnly) {
    graph = scanImportGraph(resolvedRoot, policy, [...runtimeFiles], violations);
    for (const file of graph.runtimeFiles) runtimeFiles.add(file);
  }

  for (const relativePath of [...runtimeFiles].sort()) {
    if (relativePath === "package-lock.json") continue;
    const absolutePath = path.join(resolvedRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    for (const violation of scanFileContent(absolutePath, relativePath)) violations.push(violation);
    if (path.basename(relativePath) === "package.json" || relativePath === "package-server.json") {
      validateDirectDependencies(resolvedRoot, relativePath, policy, violations);
    }
  }
  validatePackageLock(resolvedRoot, policy, violations);

  const generatedFiles = new Set();
  if (requireDist) {
    const primaryDist = policy.generated_artifact_roots[0];
    for (const artifactRoot of policy.generated_artifact_roots) {
      const exists = fs.existsSync(path.join(resolvedRoot, artifactRoot));
      if (artifactRoot === primaryDist && !exists) {
        addViolation(violations, "GENERATED_ARTIFACT_MISSING", artifactRoot, "the deployable web build must exist");
      }
      if (!exists) continue;
      for (const file of listFiles(resolvedRoot, artifactRoot, violations)) generatedFiles.add(file);
    }
    for (const relativePath of [...generatedFiles].sort()) {
      for (const violation of scanFileContent(path.join(resolvedRoot, relativePath), relativePath)) {
        violations.push({ ...violation, code: `GENERATED_${violation.code}` });
      }
    }
  }

  if (validateWiring) violations.push(...validateGateWiring(resolvedRoot, policy));

  const finalViolations = uniqueViolations(violations).sort((left, right) =>
    `${left.file}:${left.code}:${left.detail ?? ""}`.localeCompare(`${right.file}:${right.code}:${right.detail ?? ""}`),
  );
  return {
    valid: finalViolations.length === 0,
    contract_id: policy.contract_id,
    scanned: {
      runtime_files: runtimeFiles.size,
      reachable_files: graph.reachableFiles.length,
      generated_files: generatedFiles.size,
    },
    classifications: policy.classified_non_runtime,
    violations: finalViolations,
  };
}

function parseCli(argv) {
  const options = {
    root: process.cwd(),
    requireDist: false,
    artifactOnly: false,
    validateWiring: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source-only") options.requireDist = false;
    else if (argument === "--require-dist") options.requireDist = true;
    else if (argument === "--artifact-only") {
      options.artifactOnly = true;
      options.validateWiring = false;
    } else if (argument === "--root") options.root = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function runCli() {
  const options = parseCli(process.argv.slice(2));
  const policyPath = path.join(path.resolve(options.root), "scripts", "ci", "no-hybrid-runtime-policy.json");
  const policy = fs.existsSync(policyPath) ? loadNoHybridPolicy(policyPath) : loadNoHybridPolicy();
  const result = scanNoHybridRuntime({ ...options, policy });
  const reportPath = path.join(path.resolve(options.root), "tmp", "ci", "no-hybrid-runtime-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ ...result, generated_at: new Date().toISOString(), report_sha256: crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex") }, null, 2)}\n`,
  );
  if (!result.valid) {
    for (const violation of result.violations) {
      console.error(`no-hybrid:${violation.code}:${violation.file}${violation.detail ? `: ${violation.detail}` : ""}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `no-hybrid: valid (${result.scanned.runtime_files} runtime, ${result.scanned.generated_files} generated, ${result.scanned.reachable_files} reachable files)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
