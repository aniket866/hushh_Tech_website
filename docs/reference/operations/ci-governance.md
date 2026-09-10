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
- `@hushh-labs/allowed-maintainers-to-approve` (team id `17036409`) is the required code-owner and approving-review team. It has repository maintain access and is not a ruleset bypass actor.
- `@hushh-labs/main-emergency-bypass` (closed team id `19427424`) is the only bypass actor on this ruleset. Its exact members are `kushaltrivedi5`, `msainani`, `ankitkumarsingh1702`, `Jhumma-hushh`, `DamriaNeelesh`, and `RGlodAkshat`; its bypass mode is limited to pull requests. Emergency use must be documented. Normal changes require an independent approval from the maintainer team and the merge queue.
- The `deploy-uat` and `deploy-production` teams are the deployment-environment reviewer groups. The organization-wide `pipeline-editors` team is not granted access to this repository and does not own its workflow changes. Membership and reviewer assignment are live GitHub state and must be checked before a release.
- Other collaborators can push topic branches and open PRs, but cannot update protected refs or merge protected-branch PRs.
- Ruleset drift is any live bypass actor outside `main-emergency-bypass`, a missing protected-ref update rule, a missing required code-owner/review or queue gate, or any non-approved admin route that can change the ruleset.

## Default pull-request CI

- `hushh-tech-website-ci` is the default Cloud Build 2nd-generation GitHub trigger in `hushh-tech-uat` (`us-central1`) for pull requests targeting `main`. It runs `cloudbuild.ci.yaml` with a shared dependency install, concurrent web/lint/environment/retirement/no-hybrid/service/security/NDA gates, and the no-hybrid Chromium/WebKit proof.
- `.github/workflows/pr-policy.yml` is the small GitHub metadata lane for DCO, reviewer grounding, PR hygiene, Phase 2 policy, and the advisory semantic guard. `.github/workflows/cloudbuild-status-gate.yml` joins its result with the Cloud Build check and publishes the required `CI Status Gate` commit status.
- `.github/workflows/ci.yml` is named `PR Validation (GitHub backup)` and is manual-only. Use it when Cloud Build is unavailable; it remains a full, blocking fallback and does not run on every push.
- CodeQL is manual-only in `.github/workflows/codeql.yml`; it is intentionally not a PR, push, or scheduled gate. `Queue Validation` remains the GitHub `merge_group` freshness check because Cloud Build pull-request triggers cannot validate GitHub's synthetic queue ref.

## PR lanes

### `Signalkeeper Preflight`

- file: `.github/workflows/pr-intake.yml`
- trigger: `pull_request_target`
- purpose: always-visible sticky walkthrough and PR check guidance that still runs while Cloud Build or `PR Policy Gate` is waiting on approval or blocked by merge conflicts

### `Hushh Signalkeeper`

- file: `.github/workflows/pr-agent.yml`
- trigger: `pull_request_target` on `opened`, `reopened`, `ready_for_review`, and `review_requested`, plus trusted `issue_comment` slash-command follow-up on the PR thread
- purpose: first automated code review before maintainer review

Trusted maintainers can also use manual follow-up commands on the PR thread:

1. `/review` for a fresh review pass
2. `/compliance` for checklist- and security-oriented Qodo compliance analysis
3. `/checks` for CI feedback summarization

### `Semantic PR Guard`

- file: `.github/workflows/pr-policy.yml`
- trigger: `pull_request`
- purpose: warning-first semantic policy lane for traceability, deploy disclosure, auth/security narrative, and targeted proof expectations

### `Reviewer Context & Compliance`

- file: `.github/workflows/pr-policy.yml`
- trigger: `pull_request`
- purpose: blocking policy lane that verifies `Hushh Signalkeeper` is grounded by `.pr_agent.toml`, `AGENTS.md`, `QODO.MD`, `.ai_config.toml`, `best_practices.md`, `docs/project_context_map.md`, and the repo-root `pr_compliance_checklist.yaml`

### `PR Policy Gate`

- file: `.github/workflows/pr-policy.yml`
- trigger: `pull_request`
- purpose: lightweight metadata and policy checks that Cloud Build cannot evaluate from its repository event payload

### `Cloud Build Status Gate`

- file: `.github/workflows/cloudbuild-status-gate.yml`
- trigger: `check_run` completion for the Cloud Build trigger or `PR Policy Gate`
- purpose: publish the required `CI Status Gate` status only when both Cloud Build code gates and GitHub policy checks pass

### `Cloud Build CI`

- file: `cloudbuild.ci.yaml`
- trigger: 2nd-generation Cloud Build pull-request trigger `hushh-tech-website-ci`
- purpose: authoritative code, build, browser, service, security, and environment validation in GCP

### `PR Validation (GitHub backup)`

- file: `.github/workflows/ci.yml`
- trigger: manual `workflow_dispatch` only
- purpose: full GitHub Actions fallback for a Cloud Build incident; it is not the default PR lane

`Signalkeeper Preflight` and `Hushh Signalkeeper` are advisory `pull_request_target` lanes. They explain the PR state, publish the sticky walkthrough, and produce first-pass review output without executing contributor code. `PR Policy Gate` is the lightweight blocking metadata lane. `Cloud Build CI` is the authoritative code-executing surface; `Cloud Build Status Gate` publishes `CI Status Gate` only after both lanes pass. `PR Validation (GitHub backup)` is available through explicit dispatch when the primary GCP lane is unavailable.

Current Cloud Build code-gate surface:

1. `web`
2. `lint`
3. `env-contract`
4. `retirement`
5. `no-hybrid-runtime`
6. `service`
7. `security-audit`
8. `sensitive-nda-gate`
9. `secret-scan`

The `PR Policy Gate` covers DCO, reviewer grounding, PR hygiene, Phase 2 policy, and the advisory semantic guard. `Cloud Build Status Gate` combines both surfaces into `CI Status Gate`.

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

### `Deploy Email Template API`

- file: `.github/workflows/deploy-cloud-run.yml`
- trigger: `push` to `main` for `cloud-run/email-template-api/**`, plus manual dispatch
- purpose: standalone Cloud Run deployment for the email-template API surface

## Triage implications

1. `Signalkeeper Preflight` is explanatory, not merge authority.
2. `Hushh Signalkeeper` is an input, not merge authority.
3. `Semantic PR Guard` is the progressive-enforcement lane. Start new semantic checks here as advisory, and promote only the ones that prove high signal into the blocking gate later.
4. `Cloud Build CI` is the default pre-merge code-executing check surface, and `Cloud Build Status Gate` publishes its aggregate branch-protection signal as `CI Status Gate`.
5. `Sensitive NDA Gate` is blocking in PR validation and queue validation for community API regressions; the deployed-host version runs in `Deploy to UAT` because it needs UAT secrets and a real hosted app.
6. Cloud Build pull-request triggers run against the connected repository event; a collaborator comment is required only for external contributors. The GitHub backup is manual-only.
7. For fork PRs, Cloud Build's external-contributor comment control may require
   a maintainer `/gcbrun`; the GitHub policy and status-bridge workflows still
   report the PR metadata state.
8. `Queue Validation` matters for freshness and merge authority, not contributor patch review.
9. `Main Post-Merge Smoke` gates the automatic UAT promotion path for the website lane, while `Deploy Email Template API` is a separate main-branch service deploy lane.
10. If `PR Policy Gate` fails, treat `Hushh Signalkeeper` output as ungrounded until `.pr_agent.toml`, the repo-root metadata files, or `pr_compliance_checklist.yaml` are repaired on `main`.
11. `Supabase Retirement Contract` is blocking in pull requests and merge
    groups and runs again post-merge. It freezes scope; it does not prove that
    any source data has migrated or that Supabase is outside the serving path.
12. `No-Hybrid Runtime Gate` is blocking in pull requests and merge groups,
    runs again post-merge, and is embedded in the root Cloud Run image builds.
    It scans source, generated artifacts, native assets, release wiring, and a
    Chromium network trace. It must be green before a no-hybrid cutover claim.
