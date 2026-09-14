# Repository hygiene

Dead code here is a correctness problem before it is a tidiness one. Nothing in
`src/` costs a byte at runtime unless something imports it — the bundler drops
the rest — so an unreferenced module is invisible in production and expensive
everywhere else. It gets read, reasoned about, cited in a plan, and occasionally
edited. An agent or a new engineer opening `src/components/` cannot tell a live
component from one that lost its last import two releases ago.

## The standing rule

**Delete, do not retire.** A file kept "just in case" is a file the next reader
has to evaluate. Git history is the archive; a `legacy/` directory is not.

Two exceptions, both narrow, both about references a grep for imports cannot
see:

- **A frozen inventory records it.** The manifests under `migration/` assert
  what the tree contained when they were frozen. A module named there stays,
  imported or not.
- **Something outside this repository reads it.** `public/.well-known/assetlinks.json`
  is the example: nothing in the codebase references it, and it is a live
  production contract declaring Android App Links for `ai.hushh.app`.

## Before deleting anything

"Unreferenced" is not "unused". Check all four, in order:

```bash
# 1. does anything import its path?
git grep -nE "(from|import|require)\s*\(?['\"][^'\"]*/<stem>['\"]" -- src tests api cloud-run

# 2. does anything name its path as text — a test that reads it, a doc, a policy?
git grep -lF -- "<path>" -- . ':!<path>'

# 3. is it recorded in a frozen migration manifest?
grep -rF -- "<path>" migration/

# 4. is it reached from outside the repository entirely?
#    well-known files, Play Store assets, anything fetched by URL rather than imported
```

Then run the gates: `npx tsc --noEmit`, `npm test`, `npm run lint:ci`,
`npm run build:web`, `npm run migration:no-hybrid:source`, and
`npm run migration:retirement:check`. The last two matter most — they are what
notices if a deletion moved something the migration contract depends on.

## The standing report

```bash
npm run ci:dead-modules
```

Lists every module under `src/` that nothing reaches. It also runs in Cloud
Build, in the same advisory step as the merge-fidelity gate.

**Advisory, deliberately.** The rule is a heuristic with a measured
false-positive rate: in the September 2026 sweep, 5 of 34 candidates were live,
each reached by one of the two exceptions above. A report that fails a build
over those is a report somebody switches off, and the real findings go with it.
Read it; do not gate on it.

## What the September 2026 sweep removed

90 files, 4.7 MB, about 15,000 lines. 27 unimported source modules, 17 archived
page components parked under `docs/archive/src-pages`, `.planning/` and
`hushh_api_reports/` (each referenced by nothing but an ignore-file line telling
tooling to skip it), `playstore-assets/` (an Android listing with no source,
capacitor dependency or workflow left here), two service workers that
`src/main.tsx` actively unregisters on load, and two deck scripts superseded by
the pipeline the `community-decks` skill documents.

## What it deliberately left

`supabase/` (253 files) and `migration/` (52) are the largest apparent bloat in
the repository and are not candidates. The retirement contract reads
`INVENTORY_FROZEN_NOT_MIGRATED`, frozen 2026-08-20; 111 of 112 edge functions
are still `PORT_TO_GCP`. [Issue #1950](https://github.com/hushh-labs/hushh_Tech_website/issues/1950)
is open, and rule 11 reads: *"Delete or disable Supabase only after post-cutover
non-use proof; never before."* That tree is the source of truth for work nobody
has done yet. Revisit when the contract state changes, not before.

## Known bloat that is not stale

Referenced, therefore not a hygiene question, but worth fixing on its own:

- `public/gif/typing.gif` is **40 MB** and is rendered by
  `src/pages/services/consumers.tsx`. It is two thirds of `public/` on its own.
  An MP4 or animated WebP would be a fraction of the size.
- The production bundle ships single JPEGs of **22 MB**, **9 MB** and **7 MB**
  from the market-update content, and `index-*.js` exceeds 5 MB minified.
