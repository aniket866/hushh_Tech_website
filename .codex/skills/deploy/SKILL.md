---
name: deploy
description: >-
  Use when deploying the HushhTech web app to UAT or PROD, triggering the
  deploy-uat / deploy-prod GitHub Actions workflows, picking a safe "green main"
  SHA to ship, or when deployments feel slow and you want to cut the CI/CD cycle
  time. Trigger this whenever the user mentions deploying, shipping, releasing,
  pushing to UAT / prod / Cloud Run, a slow build or deploy pipeline, or asks how
  to make deploys faster — even for tiny changes. Covers the exact deploy
  procedure, the safety gates, the full pipeline anatomy, and a prioritized
  playbook of levers to reduce deploy time.
---

# HushhTech Deploy & Speedup

This repo ships a Vite/React + Express app to **Google Cloud Run** in two
environments. Deploys run through GitHub Actions — you do not `gcloud deploy`
from a laptop. Pull-request code validation runs through the
`hushh-tech-website-ci` Cloud Build trigger; GitHub Actions keeps a manual full
suite backup and owns merge-group freshness. This skill covers how to deploy
safely and how to make the cycle faster.

> Ownership note: `.github/workflows`, `scripts/ci`, and the deploy scripts are
> *owned* by the `repo-operations` skill. This skill is the focused
> "how to deploy + speed it up" companion. For broad CI-governance / branch-
> protection / merge-queue questions, prefer `repo-operations`.

## Environments

| Env  | URL                     | GCP project      | Cloud Run service   | Trigger |
|------|-------------------------|------------------|---------------------|---------|
| UAT  | https://uat.hushhtech.com | `hushh-tech-uat`  | `hushh-tech-website` | Auto after post-merge smoke on `main`, or manual |
| PROD | https://hushhtech.com   | `hushh-tech-prod` | `hushh-tech-website` | Manual only, with an explicit green-`main` SHA |

Region is `us-central1` for both.

## How to deploy

**Golden rule: only ever deploy a SHA that is green on `main`.** Both workflows
validate the SHA against the `Main Post-Merge Smoke Gate` check via
`scripts/ci/require-deploy-sha-on-main.sh` and refuse otherwise. Don't try to
bypass this — it is the line between "tested" and "hope".

### UAT
UAT deploys **automatically** when the `Main Post-Merge Smoke` workflow finishes
successfully on `main` (see `.github/workflows/deploy-uat.yml`). To deploy UAT
manually (defaults to latest `origin/main` if no SHA given):

```bash
gh workflow run deploy-uat.yml --ref main            # latest green main
gh workflow run deploy-uat.yml --ref main -f sha=<green-main-sha>
```

For community sensitive-document work, a UAT deploy is not done until the hosted
`Verify sensitive NDA gate on deployed host` step passes. That step runs
`npm run verify:sensitive-nda-gate -- --target=uat --expected-min=1` against
`https://uat.hushhtech.com`, creates a temporary user, proves sensitive posts are
blocked before NDA signature, signs the NDA, proves list/detail access opens,
browser-smokes a sensitive article, and deletes the temporary user.

### PROD
PROD is **manual only** and requires the exact SHA:

```bash
# 1. Find a green main SHA (must have the post-merge smoke gate passing)
gh run list --workflow "Main Post-Merge Smoke" --branch main --limit 5

# 2. Dispatch the prod deploy with that SHA
gh workflow run deploy-prod.yml --ref main -f sha=<green-main-sha>

# 3. Watch it
gh run watch "$(gh run list --workflow deploy-prod.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Deploys use `concurrency: cancel-in-progress: false` — **never cancel a running
deploy to start another**; let it finish so Cloud Run isn't left half-updated.

### What a deploy actually does
`npm ci` → load secrets from GCP Secret Manager → validate client env →
`npm run env:check` → `npm run build:web` (builds `dist/` in the runner) →
`gcloud run deploy --source .` (remote Cloud Build from the runtime
[`Dockerfile`](../../../Dockerfile)) → Playwright Chromium install → OAuth smoke
against the deployed host → sensitive-document NDA gate verification against the
deployed host. Full step-by-step in
[references/pipeline.md](references/pipeline.md).

## Why deploys feel slow (and the fix)

The expensive path is now concentrated in one Cloud Build PR fan-out (shared
install, cache, and concurrent gates), followed by post-merge smoke and a
deploy that rebuilds a container from source and installs a browser. Apply
these levers, **highest impact first**.
File/line anchors are in [references/pipeline.md](references/pipeline.md).

1. **Deploy a prebuilt image instead of `--source .` (biggest win).**
   `gcloud run deploy --source .` re-uploads source and runs a *cold* remote
   Cloud Build every time (~minutes), even though `dist/` was already built in
   the runner. Build the runtime image in the runner with `docker buildx` +
   GitHub Actions layer cache (`cache-from/to: type=gha`), push to Artifact
   Registry, then `gcloud run deploy --image <ref>`. The server-deps layer
   (`package-server.json`) caches across deploys, so a frontend-only change just
   swaps the `dist/` layer → deploy in seconds. Reconsider `--clear-base-image`.

2. **Skip heavy Cloud Build jobs when nothing relevant changed (path-aware CI).**
   Add reviewed `includedFiles` or `ignoredFiles` filters to the
   `hushh-tech-website-ci` trigger only when the affected-surface contract is
   explicit. Keep `secret-scan`, policy, and security gates on for every
   code-bearing pull request.

3. **Cache dependencies and pin browser tooling.** Cloud Build installs the
   root tree once with a lockfile-keyed npm download cache; its service lane
   reuses that cache. The no-hybrid gate uses the version-pinned
   `mcr.microsoft.com/playwright:v1.57.0-noble` image, so Chromium/WebKit system
   packages and browser binaries are not downloaded on every pull request.
   Deploys still run their own environment-scoped install.

4. **Decouple tests from build; run affected-only on PRs.** `npm run build` is
   `vitest run && build:web` — the Vite build is fast, the full test suite is the
   slow part. Run `vitest related`/changed-only for PR feedback and keep the full
   suite on the post-merge / prod gate. Add a local `build:check`
   (`tsc --noEmit && vite build`) for quick local validation without tests.

5. **Cache `build:assets`.** `build:web` regenerates the community snapshot +
   sitemap + robots on every build; skip/cache when their inputs are unchanged.

6. **Kill pipeline redundancy.** Three deploy mechanisms coexist: GitHub Actions
   `--source .` (runtime [`Dockerfile`](../../../Dockerfile)), Cloud Build
   triggers (`cloudbuild-uat.yaml` / `cloudbuild-prod.yaml` → `Dockerfile.gcp`,
   which builds Vite *inside* the image), and Vercel (`vercel.json`). Maintaining
   parallel pipelines multiplies time and invites drift. Pick one source of truth
   per env (keep Vercel for previews if you use it; retire whichever is legacy).

**Recommended order:** start with #2 + #3 (low-risk, save minutes immediately),
then #1 (biggest win) — but test #1 on UAT first since it rewrites the prod
deploy path.

## Gotchas
- A deploy that ships a `dist/` missing compiled Supabase auth config fails *in
  the container build* on purpose (see the guard in the `Dockerfile`). If a
  deploy dies there, the build-time `VITE_SUPABASE_*` env wasn't injected.
- PROD must be dispatched from `main` (the workflow asserts `GITHUB_REF_NAME`).
- The smoke step uploads an artifact and is `if: always()` — a red smoke still
  surfaces the JSON for debugging.
