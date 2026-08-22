import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const ROOT = process.cwd();
const OUTPUT = "tests/noHybridRouteInventory.generated.json";
const ROUTE_WRAPPERS = Object.freeze([
  "AuthRequiredRoute",
  "FundAdminRoute",
  "InvestorAccessRoute",
  "ProtectedRoute",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function concreteRoute(pattern) {
  if (pattern === "*") return "/__no_hybrid_not_found_fixture__";
  let route = pattern.replace(/\/\*$/, "/__no_hybrid_wildcard_fixture__");
  route = route.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
    if (/token/i.test(name)) return "invalid-fixture-token";
    if (/slug/i.test(name)) return "fixture-slug";
    if (/user/i.test(name)) return "fixture-user-a";
    return "fixture-id";
  });
  return route;
}

function stringAttribute(opening, name) {
  const attribute = opening.attributes.properties.find(
    (candidate) => ts.isJsxAttribute(candidate) && candidate.name.text === name,
  );
  if (!attribute?.initializer || !ts.isStringLiteral(attribute.initializer)) return null;
  return attribute.initializer.text;
}

function clientRoutes(root) {
  const relative = "src/App.tsx";
  const sourceText = fs.readFileSync(path.join(root, relative), "utf8");
  const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const routes = [];
  const visit = (node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening?.tagName?.getText(source) === "Route") {
      const pattern = stringAttribute(opening, "path");
      if (!pattern) throw new Error("Every React Route must use a static string path.");
      const text = node.getText(source);
      const wrappers = ROUTE_WRAPPERS.filter((name) => text.includes(`<${name}`));
      routes.push({
        pattern,
        sample: concreteRoute(pattern),
        access: wrappers.includes("FundAdminRoute")
          ? "firebase-admin"
          : wrappers.length
            ? "firebase-user"
            : "anonymous",
        wrappers,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
  if (new Set(routes.map((route) => route.pattern)).size !== routes.length) {
    throw new Error("React route inventory contains duplicate patterns.");
  }
  return routes;
}

function serverRoutes(root) {
  const relative = "server.js";
  const sourceText = fs.readFileSync(path.join(root, relative), "utf8");
  const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const byPattern = new Map();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "app"
    ) {
      const method = node.expression.name.text.toUpperCase();
      const first = node.arguments[0];
      if (["ALL", "DELETE", "GET", "PATCH", "POST", "PUT", "USE"].includes(method) && first && ts.isStringLiteral(first)) {
        const pattern = first.text;
        const existing = byPattern.get(pattern) || { pattern, sample: concreteRoute(pattern), methods: [] };
        existing.methods.push(method);
        byPattern.set(pattern, existing);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...byPattern.values()]
    .map((route) => ({ ...route, methods: [...new Set(route.methods)].sort() }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

async function functionRoutes(root) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "scripts/ci/no-hybrid-runtime-policy.json"), "utf8"));
  const registryPath = policy.frozen_compatibility_contract.registry_path;
  const module = await import(`${pathToFileURL(path.join(root, registryPath)).href}?inventory=${Date.now()}`);
  const entries = module.GCP_BACKEND_RETIREMENT_FUNCTIONS;
  if (!Array.isArray(entries)) throw new Error("Generated function registry export is missing.");
  const routes = entries.map((entry) => ({
    slug: entry.slug,
    route: `/functions/v1/${entry.slug}`,
    auth: entry.auth_mode,
    state: entry.migration_state,
    disposition: entry.final_disposition,
  })).sort((a, b) => a.slug.localeCompare(b.slug));
  if (routes.length !== policy.frozen_compatibility_contract.expected_route_count) {
    throw new Error(`Expected ${policy.frozen_compatibility_contract.expected_route_count} function routes; found ${routes.length}.`);
  }
  if (new Set(routes.map((route) => route.slug)).size !== routes.length) {
    throw new Error("Function route inventory contains duplicate slugs.");
  }
  return routes;
}

export async function buildNoHybridRouteInventory(root = ROOT) {
  const client = clientRoutes(root);
  const server = serverRoutes(root);
  const functions = await functionRoutes(root);
  for (const required of ["/api/gcp/data", "/api/gcp/storage/*", "/functions/v1/*"]) {
    if (!server.some((route) => route.pattern === required)) throw new Error(`Server route ${required} is missing.`);
  }
  const personas = [
    { id: "anonymous", authority: "none" },
    { id: "firebase-user-a", authority: "hushh-tech-uat" },
    { id: "firebase-user-b", authority: "hushh-tech-uat" },
    { id: "firebase-admin", authority: "hushh-tech-uat", claim: "fund_admin" },
  ];
  const body = {
    schema_version: 1,
    target_project: "hushh-tech-uat",
    browsers: ["chromium", "webkit"],
    personas,
    client,
    server,
    functions,
    counts: {
      client: client.length,
      client_anonymous: client.filter((route) => route.access === "anonymous").length,
      client_user: client.filter((route) => route.access === "firebase-user").length,
      client_admin: client.filter((route) => route.access === "firebase-admin").length,
      server: server.length,
      functions: functions.length,
      functions_ported: functions.filter((route) => route.state === "PORTED_AND_VERIFIED").length,
      functions_retired: functions.filter((route) => route.disposition === "RETIRE_WITH_410").length,
      functions_blocked: functions.filter((route) => route.state !== "PORTED_AND_VERIFIED" && route.disposition !== "RETIRE_WITH_410").length,
    },
  };
  return { ...body, sha256: sha256(JSON.stringify(body)) };
}

async function main() {
  const inventory = await buildNoHybridRouteInventory(ROOT);
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  const target = path.join(ROOT, OUTPUT);
  if (process.argv.includes("--write")) {
    fs.writeFileSync(target, output);
    console.log(`no-hybrid-route-inventory: wrote ${OUTPUT} (${inventory.sha256})`);
    return;
  }
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
    console.error(`no-hybrid-route-inventory: stale ${OUTPUT}; run with --write`);
    process.exitCode = 1;
    return;
  }
  console.log(`no-hybrid-route-inventory: valid (${inventory.counts.client} client, ${inventory.counts.server} server, ${inventory.counts.functions} function routes)`);
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
