# CI Governance

This document describes the current Hushhtech PR and deploy lanes that the OSS contribution triage skill should trust.

The operator state machine for moving a reviewed change through the queue,
`main`, UAT, production, and any GCP community-content sync is
[Admin Merge And Release SOP](./admin-release-sop.md). This page records the
individual gates; the SOP records their order and the evidence required at each
authority transition.

## Protected branch authority

- GitHub repository rulesets protect `main` and `develop`; classic branch protection is not authoritative for this repository.
- The active `Protect main branch` ruleset is id `15210186`; its merge queue uses `HEADGREEN`, a five-minute minimum wait, and a maximum of two entries.
- `@ankitkumarsingh1702` (GitHub user id `94732725`), `@Jhumma-hushh` (GitHub user id `262395004`), and `@kushaltrivedi5` (GitHub user id `40542375`) may bypass pull request review rules or merge protected-branch PRs.
- The `Allowed Maintainers to Approve` team (id `17036409`) is also a ruleset pull-request bypass actor. It is the group path for approved maintainers, currently including `msainani` alongside the named maintainers.
- The `deploy-uat` and `deploy-production` teams are the deployment-environment reviewer groups. `pipeline-editors` is the repository workflow-maintenance group. Membership and reviewer assignment are live GitHub state and must be checked before a release.
- Other collaborators can push topic branches and open PRs, but cannot update protected refs or merge protected-branch PRs.
- Ruleset drift is any live bypass actor outside the approved users/team, any missing protected-ref update rule, or any non-approved admin route that can change the ruleset.

## PR lanes

### `Signalkeeper Preflight`

- file: `.github/workflows/pr-intake.yml`
- trigger: `pull_request_target`
- purpose: always-visible sticky walkthrough and PR check guidance that still runs when `PR Validation` is waiting on fork approval or blocked by merge conflicts

### `Hushh Signalkeeper`

- file: `.github/workflows/pr-agent.yml`
- trigger: `pull_request_target` on `opened`, `synchronize`, `reopened`, and `ready_for_review`, plus trusted `issue_comment` slash-command follow-up on the PR thread
- purpose: first automated code review before maintainer review

Trusted maintainers can also use manual follow-up commands on the PR thread:

1. `/review` for a fresh review pass
2. `/compliance` for checklist- and security-oriented Qodo compliance analysis
3. `/checks` for CI feedback summarization

### `Semantic PR Guard`

- file: `.github/workflows/ci.yml`
- trigger: `pull_request`
- purpose: warning-first semantic policy lane for traceability, deploy disclosure, auth/security narrative, and targeted proof expectations

### `Reviewer Context & Compliance`

- file: `.github/workflows/ci.yml`
- trigger: `pull_request`
- purpose: blocking policy lane that verifies `Hushh Signalkeeper` is grounded by `.pr_agent.toml`, `AGENTS.md`, `QODO.MD`, `.ai_config.toml`, `best_practices.md`, `docs/project_context_map.md`, and the repo-root `pr_compliance_checklist.yaml`

### `PR Validation`

- file: `.github/workflows/ci.yml`
- trigger: `pull_request`
- purpose: authoritative pre-merge code-executing checks against the PR merge result

`Signalkeeper Preflight` and `Hushh Signalkeeper` are advisory `pull_request_target` lanes. They explain the PR state, publish the sticky walkthrough, and produce first-pass review output without executing contributor code. `Semantic PR Guard` is the first advisory `pull_request` lane inside `PR Validation`: it executes against the merge result, but it is currently warning-first and is not part of the blocking gate. `Reviewer Context & Compliance` is a blocking `pull_request` policy lane inside `PR Validation`: it verifies that the live reviewer and repo policy sources exist, parse, and are wired into `.pr_agent.toml`. `PR Validation` remains the authoritative code-executing surface that contributors and maintainers should treat as the actual pre-merge merge-authority lane.

Current `PR Validation` check surface:

1. `DCO`
2. `Secret Scan`
3. `Env Contract Check`
4. `Supabase Retirement Contract`
5. `No-Hybrid Runtime Gate`
6. `Reviewer Context & Compliance`
7. `PR Hygiene`
8. `Semantic PR Guard` (advisory-first; not yet in `CI Status Gate`)
9. `GCP Service Foundation`
10. `GCP Cloud SQL Attestor`
11. `Web Validation`
12. `Lint`
13. `Security Audit`
14. `Sensitive NDA Gate`
15. `CI Status Gate`

## Queue and post-merge lanes

### `Queue Validation`

- file: `.github/workflows/queue-validation.yml`
- trigger: `merge_group`
- purpose: authoritative freshness-at-merge-time validation, including the
  frozen Supabase retirement inventory

### `Main Post-Merge Smoke`

- file: `.github/workflows/main-post-merge-smoke.yml`
- trigger: `push` to `main`
- purpose: post-merge deploy-eligibility proof on landed `main` SHA, with the
  retirement contract checked before the deploy artifact is built

## Deploy lanes

### `Deploy to UAT`

- file: `.github/workflows/deploy-uat.yml`
- trigger: successful `Main Post-Merge Smoke` via `workflow_run`, plus optional manual dispatch with `sha`
- purpose: UAT promotion from a green `main` SHA, followed by hosted OAuth smoke and live sensitive-document NDA gate verification

After Cloud Run deployment, the UAT lane runs `npm run verify:sensitive-nda-gate -- --target=uat --expected-min=1`.
That check creates a temporary test user, proves sensitive community posts fail closed before NDA signature, signs the NDA, proves the gated sensitive list/detail page opens, browser-smokes a sensitive article, and deletes the temporary user. A green UAT deploy is not authoritative for community sensitive content unless this step passes.

### `Deploy to PROD`

- file: `.github/workflows/deploy-prod.yml`
- purpose: manual promotion from an approved green `main` SHA

### Direct GCP UAT lane

- file: `deploy/uat-tag-trigger.cloudbuild.yaml`
- registration: `scripts/gcp/register-direct-uat-trigger.sh` (plan by default; `--apply` is explicit)
- trigger: an explicit `uat-*` tag in Cloud Build, after the repository link and deployer identity have been reviewed
- purpose: execute the existing read-modify-write UAT deploy helper inside GCP when an operator needs a deploy without a GitHub-hosted runner

This lane is execution-only. It does not validate pull requests, enter the merge queue, establish a green `main` SHA, or authorize production. Keep `PR Validation`, `Queue Validation`, `Main Post-Merge Smoke`, and the environment-gated Actions release workflows as the merge and release authority until an equivalent Cloud Build status-reporting and production evidence contract is proven. Do not add a push-to-`main` trigger alongside the post-merge UAT workflow; that would deploy twice.

### `Deploy Email Template API`

- file: `.github/workflows/deploy-cloud-run.yml`
- trigger: `push` to `main` for `cloud-run/email-template-api/**`, plus manual dispatch
- purpose: standalone Cloud Run deployment for the email-template API surface

## Triage implications

1. `Signalkeeper Preflight` is explanatory, not merge authority.
2. `Hushh Signalkeeper` is an input, not merge authority.
3. `Semantic PR Guard` is the progressive-enforcement lane. Start new semantic checks here as advisory, and promote only the ones that prove high signal into the blocking gate later.
4. `PR Validation` is the main pre-merge code-executing check surface, and its aggregate branch-protection signal is `CI Status Gate`.
5. `Sensitive NDA Gate` is blocking in PR validation and queue validation for community API regressions; the deployed-host version runs in `Deploy to UAT` because it needs UAT secrets and a real hosted app.
6. GitHub runs `pull_request` workflows from the PR merge branch, so merge-conflicted PRs will not show `PR Validation` until the conflicts are resolved.
7. For fork PRs, a maintainer may still need to approve code-executing workflows before the full `PR Validation` story is visible.
8. `Queue Validation` matters for freshness and merge authority, not contributor patch review.
9. `Main Post-Merge Smoke` gates the automatic UAT promotion path for the website lane, while `Deploy Email Template API` is a separate main-branch service deploy lane.
10. If `Reviewer Context & Compliance` fails, treat `Hushh Signalkeeper` output as ungrounded until `.pr_agent.toml`, the repo-root metadata files, or `pr_compliance_checklist.yaml` are repaired on `main`.
11. `Supabase Retirement Contract` is blocking in pull requests and merge
    groups and runs again post-merge. It freezes scope; it does not prove that
    any source data has migrated or that Supabase is outside the serving path.
12. `No-Hybrid Runtime Gate` is blocking in pull requests and merge groups,
    runs again post-merge, and is embedded in the root Cloud Run image builds.
    It scans source, generated artifacts, native assets, release wiring, and a
    Chromium network trace. It must be green before a no-hybrid cutover claim.
