#!/usr/bin/env node
/**
 * Reports source modules nothing imports.
 *
 * Dead code in this repository is a correctness problem before it is a tidiness one. An agent — or
 * a new engineer — reading src/components/ has no way to tell a live component from one that lost
 * its last import two releases ago, so it gets read, reasoned about, and sometimes edited. The
 * September 2026 sweep removed 27 such modules, over 5,000 lines; every one of them had been
 * costing attention for months without costing a single byte at runtime.
 *
 * ADVISORY, not blocking, and that is not timidity. The rule below is a heuristic with a real
 * false-positive rate: of 34 candidates in that sweep, 5 were live — reached through a test that
 * reads the file by path, a doc that names it, or a frozen migration manifest that records it.
 * A gate that fails a build over those is a gate somebody switches off, and then the real findings
 * go with it. This repository already draws that line the same way for merge fidelity.
 *
 * A module counts as referenced if ANY of these hold, in this order:
 *   1. Something imports its path       — `from "…/Foo"`, `import("…/Foo")`, `require("…/Foo")`
 *   2. Something names its path as text — a test that reads it, a doc, a policy file
 *   3. A frozen migration manifest records it — that inventory must keep matching the tree
 *
 * Entry points and barrels are never reported: an entry point is reached by the bundler and a
 * barrel by its directory name, so neither is ever "imported" by path.
 *
 * Usage:
 *   node scripts/ci/report-dead-modules.mjs          # print the report
 *   node scripts/ci/report-dead-modules.mjs --json   # machine-readable
 */

import { execFileSync } from "node:child_process";

/** Reached by the bundler or by directory name, so an import of the path never appears. */
const ENTRY_POINTS = new Set(["src/main.tsx", "src/App.tsx", "src/vite-env.d.ts"]);
const isBarrel = (file) => /\/index\.[cm]?[jt]sx?$/.test(file);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Tracked files, so untracked scratch work never appears in the report. */
const tracked = () => git("ls-files", "-z").split("\0").filter(Boolean);

const sourceModules = (files) =>
  files.filter(
    (file) =>
      file.startsWith("src/") &&
      /\.[cm]?[jt]sx?$/.test(file) &&
      !file.endsWith(".d.ts") &&
      !isBarrel(file) &&
      !ENTRY_POINTS.has(file),
  );

/**
 * Which modules nothing reaches.
 *
 * Pure apart from the corpus it is handed, because the decision is the part worth testing and
 * walking the repository is not.
 */
export const findDeadModules = ({ modules, corpus }) => {
  const dead = [];
  for (const file of modules) {
    const stem = file.replace(/^.*\//, "").replace(/\.[cm]?[jt]sx?$/, "");
    // Anchored on a path separator or a relative prefix, so `Hero` does not match `HushhIDHero`.
    const imported = new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*["'][^"']*(?:/|^\\.?/?)${stem}["']`,
    );
    let referenced = false;
    for (const [path, text] of corpus) {
      if (path === file) continue;
      if (imported.test(text) || text.includes(file)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) dead.push(file);
  }
  return dead;
};

const TEXT = /\.(m?[jt]sx?|json|md|ya?ml|toml|html|sh|txt)$/;

const run = () => {
  const files = tracked();
  const modules = sourceModules(files);
  const corpus = [];
  for (const file of files) {
    if (!TEXT.test(file)) continue;
    try {
      corpus.push([file, git("show", `HEAD:${file}`)]);
    } catch {
      // A file staged for deletion, or one git cannot show. Skipping it can only make the report
      // more conservative, never less.
    }
  }

  const dead = findDeadModules({ modules, corpus });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ scanned: modules.length, dead }, null, 2));
    return;
  }

  console.log(`dead-modules: scanned ${modules.length} source module(s) under src/`);
  if (!dead.length) {
    console.log("dead-modules: every one of them is reached. Nothing to report.");
    return;
  }
  console.log(`dead-modules: ${dead.length} reached by nothing:\n`);
  for (const file of dead) console.log(`  ${file}`);
  console.log(
    "\nAdvisory. Before deleting one, check it is not read by path in a test, named in a doc," +
      "\nor recorded in a frozen manifest under migration/ — those are live references a grep for" +
      "\nimports cannot see.",
  );
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) run();
