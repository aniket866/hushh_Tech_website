---
name: repo-operations
description: Use when working on Hushhtech PR checks, CI/CD, branch protection, merge queue, deploys, env parity, or operational verification.
---

# Hushhtech Repo Operations Skill

## Purpose and Trigger

- Primary scope: `repo-operations-intake`
- Trigger on PR-check failures, workflow truth, branch protection, merge queue, deploy state, and fork-approval questions.
- Avoid overlap with `oss-contribution-triage`, `repo-context`, and direct product implementation skills.

## Coverage and Ownership

- Role: `owner`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `.github/workflows`
2. `cloudbuild.ci.yaml`
3. `scripts/gcp/register-ci-trigger.sh`
4. `docs/reference/operations/cloudbuild-ci.md`
5. `scripts/ci`
6. `scripts/security`
7. `scripts/check-production.sh`
8. `scripts/deploy-gcp.sh`
9. `scripts/deploy-location-geocode.sh`
10. `scripts/deploy-ria-intelligence-api.sh`
11. `scripts/gcloud-devops-setup.sh`
12. `scripts/refresh-vertex-ai-token.sh`
13. `scripts/setup-cloud-scheduler-token-refresh.sh`
14. `scripts/setup-token-refresh-cron.sh`
15. `scripts/update-supabase-auth-url.sh`
16. `docs/reference/operations/README.md`
17. `docs/reference/operations/ci-governance.md`

Non-owned surfaces:

1. `oss-contribution-triage`
2. `frontend`
3. `backend`
4. `security-audit`

## Do Use

1. Deciding whether checks ran, what failed, and which statuses are authoritative.
2. Branch protection, merge queue, and post-merge workflow questions.
3. UAT or production workflow governance.

## Do Not Use

1. Final PR bucket selection by itself.
2. Product logic review or UI review.
3. Deep auth/security reasoning beyond operational controls.

## Read First

1. `docs/reference/operations/ci-governance.md`
2. `docs/reference/operations/README.md`
3. `docs/reference/operations/cloudbuild-ci.md`
4. `cloudbuild.ci.yaml`
5. `.github/workflows/ci.yml`
6. `.github/workflows/pr-agent.yml`
7. `.github/workflows/pr-intake.yml`
8. `scripts/ci/orchestrate.sh`

## Workflow

1. Determine whether the visible checks are the full intended check surface.
2. Treat Cloud Build `hushh-tech-website-ci` as the default code lane using the
   existing `cloud-run-build` non-deployer identity, `PR Policy Gate`
   as the metadata lane, and `Cloud Build Status Gate` as the `CI Status Gate` bridge.
   Treat the full `PR Validation (GitHub backup)` workflow as manual incident recovery.
3. Separate PR feedback lane, queue lane, and post-merge lane.
4. Report which failing checks are process-only versus code-authoritative.
5. For community sensitive-document work, require the blocking `Sensitive NDA Gate`
   PR/queue check and the deployed-host UAT verifier before calling the gate
   healthy.
6. Hand back the PR decision to `oss-contribution-triage` once the CI truth is clear.

## Handoff Rules

1. Route final PR bucket selection back to `oss-contribution-triage`.
2. Route proof-selection questions to `quality-contracts`.
3. Route auth, env, secret, or fail-closed risk to `security-audit`.
4. Route code fixes to `frontend` or `backend`.

## Required Checks

```bash
npm run env:check
npm run lint:ci
npm run security:audit
npm run verify:sensitive-nda-gate -- --target=uat
bash scripts/ci/orchestrate.sh queue
npm run gcp:ci-trigger:plan
```
