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
from a laptop. This skill covers how to deploy safely and how to make the cycle
faster.

> Ownership note: `.github/workflows`, `scripts/ci`, and the deploy scripts are
> *owned* by the `repo-operations` skill. This skill is the focused
> "how to deploy + speed it up" companion. For broad CI-governance / branch-
> protection / merge-queue questions, prefer `repo-operations`.

> Deploying a **branch** rather than a green `main`, or working where Actions and
> `gcloud` are both unavailable? Use `branch-uat-deploy` instead — it ships to UAT
> through the Cloud Build and Cloud Run REST APIs with a read-modify-write PATCH,
> and its credential is 403 on production by construction. This skill remains the
> only path to production.

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

### UAT from a branch (validation, not release)

The golden rule above is about releases. Validating a branch on UAT before it can
be green on `main` is a different job, and `.github/workflows/deploy-uat.yml`
correctly refuses to do it. Use the branch path instead:

```bash
node scripts/deploy/uat-deploy.mjs --dry-run   # print the build and the service patch
npm run deploy:uat                             # build HEAD in Cloud Build, then patch Cloud Run
npm run verify:deployment                      # 22 checks against the deployed host
```

It needs `GCP_DEPLOY_SA_KEY_B64` and no gcloud. It refuses to run on a dirty tree,
so `DEPLOY_COMMIT_SHA` always names the commit the image was built from. The
deploy is a read-modify-write on the live service — it changes only the image, the
commit SHA and the revision labels — and it fails if the env var count moves,
printing the `--rollback` command. Never use it for prod: the key is 403 there.

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
against the deployed host. Full step-by-step in
[references/pipeline.md](references/pipeline.md).

## Why deploys feel slow (and the fix)

The pain is real: every change — even a one-liner — goes through the full
gauntlet (PR validation with a 35-min `web-validation` job, post-merge smoke,
then a deploy that rebuilds a container from source and installs a browser).
There is currently no fast lane. Apply these levers, **highest impact first**.
File/line anchors are in [references/pipeline.md](references/pipeline.md).

1. **Deploy a prebuilt image instead of `--source .` (biggest win).**
   `gcloud run deploy --source .` re-uploads source and runs a *cold* remote
   Cloud Build every time (~minutes), even though `dist/` was already built in
   the runner. Build the runtime image in the runner with `docker buildx` +
   GitHub Actions layer cache (`cache-from/to: type=gha`), push to Artifact
   Registry, then `gcloud run deploy --image <ref>`. The server-deps layer
   (`package-server.json`) caches across deploys, so a frontend-only change just
   swaps the `dist/` layer → deploy in seconds. Reconsider `--clear-base-image`.

2. **Skip heavy CI jobs when nothing relevant changed (path-aware CI).**
   In `.github/workflows/ci.yml`, gate `web-validation`, `lint`, and e2e behind
   a `dorny/paths-filter` (or `paths:` / `paths-ignore:`) so docs/config-only
   PRs don't pay the 35-min build. Keep `secret-scan` / `security-audit` always
   on — this is a fund; security gates stay.

3. **Cache `node_modules` and Playwright.** The 9 PR jobs + both deploys each run
   a fresh `npm ci` (only the npm download cache is shared, not `node_modules`).
   Add `actions/cache` on `node_modules` keyed by `package-lock.json`. Cache
   Playwright browsers (`~/.cache/ms-playwright`) — or replace the browser-based
   OAuth smoke with a plain `node fetch` health check so Chromium isn't
   downloaded at deploy time at all.

4. **Decouple tests from build; run affected-only on PRs.** `npm run build` is
   `vitest run && build:web` — the Vite build is fast, the full test suite is the
   slow part. Run `vitest related`/changed-only for PR feedback and keep the full
   suite on the post-merge / prod gate. Add a local `build:check`
   (`tsc --noEmit && vite build`) for quick local validation without tests.

5. **Cache `build:assets`.** `build:web` regenerates the community snapshot +
   sitemap + robots on every build; skip/cache when their inputs are unchanged.

6. **Kill pipeline redundancy.** Deploy paths that coexist: GitHub Actions
   `--source .` (runtime [`Dockerfile`](../../../Dockerfile), `dist/` prebuilt on
   the runner), the branch path above (`Dockerfile.gcp`, Vite built inside the
   image), and Vercel (`vercel.json`). `cloudbuild-uat.yaml` and
   `cloudbuild-prod.yaml` are NOT a third path — no Cloud Build trigger exists in
   either project, and the UAT file's deploy step has been removed because its
   `--set-env-vars` / `--set-secrets` would have replaced 48 env bindings with 16.
   Pick one source of truth per env (keep Vercel for previews if you use it).

**Recommended order:** start with #2 + #3 (low-risk, save minutes immediately),
then #1 (biggest win) — but test #1 on UAT first since it rewrites the prod
deploy path.

## Gotchas
- A deploy that ships a `dist/` missing compiled Firebase auth config fails *in
  the container build* on purpose. Both `Dockerfile` and `Dockerfile.gcp` grep the
  built bundle for `identitytoolkit.googleapis.com`. If a deploy dies there, the
  build-time `VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_AUTH_DOMAIN` were not
  injected — without the guard it would have shipped a login page whose OAuth
  client is undefined.
- PROD must be dispatched from `main` (the workflow asserts `GITHUB_REF_NAME`).
- The smoke step uploads an artifact and is `if: always()` — a red smoke still
  surfaces the JSON for debugging.
