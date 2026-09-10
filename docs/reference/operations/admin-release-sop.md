# Admin Merge And Release SOP

This is the operator contract for taking a reviewed Hushh Tech change from a
pull request through `main`, UAT, and production. It is a state machine, not a
replacement for the repository ruleset or the workflow files. Live GitHub
state and the exact commit SHA are authoritative.

## Authority boundaries

1. The ordinary path is Cloud Build code validation plus the GitHub PR Policy
   and `CI Status Gate`, followed by the protected `main` merge
   queue.
2. An Admin PR landing is a governed queue bypass, not a validation bypass. It
   requires an explicit decision to use the Admin path and an actor listed in
   the live `main` ruleset bypass actors.
3. Required code-owner review and deployment-environment approval are separate
   controls. A repository admin who is not a configured reviewer or bypass
   actor cannot approve those controls by implication.
4. Merge, post-merge smoke, UAT, production, and Firestore content sync are
   separate authority transitions. Completing one does not authorize the next.
5. Never copy UAT credentials, production credentials, or runtime identities
   between projects. Use the environment-scoped GitHub secrets and workload
   identities already referenced by the workflows.

## 1. Preserve the operator worktree

Record the starting branch and tree before any merge or release work:

```bash
git branch --show-current
git status --short --branch
git fetch origin main
git fetch origin <active-topic-branch>
```

Continue on the existing branch. Do not create a convenience release branch,
and do not switch the developer's worktree to `main` merely to inspect a PR.

## 2. Prove the exact PR head

Before requesting queue entry or using the Admin path, record these values from
live GitHub state:

```bash
gh pr view <number> --repo hushh-labs/hushh_Tech_website \
  --json number,state,baseRefName,headRefName,headRefOid,author,mergeable,mergeStateStatus,reviewDecision,reviewRequests,statusCheckRollup
```

The PR must target `main`, be mergeable, have no unresolved conversations, and
have every required check for the exact `headRefOid` in a terminal successful
state. Also verify DCO, secret scanning, changed-surface checks, and the PR
body before changing merge state. Re-read `headRefOid` immediately before the
state-changing command; stop if it changed.

## 3. Ordinary merge-queue path

Request the exact reviewed head:

```bash
gh pr merge <number> --repo hushh-labs/hushh_Tech_website \
  --merge --match-head-commit <head-sha>
```

Confirm a real merge-queue entry through live GitHub state. Enabling
auto-merge or receiving a successful CLI response is not proof that the PR is
queued. Monitor `Queue Validation` to completion, then monitor `Main
Post-Merge Smoke` for the landed `main` SHA.

If GitHub reports `REVIEW_REQUIRED`, an independent code-owner review is still
missing. Request that review and report the blocker; do not claim queue entry.

## 4. Explicit Admin PR landing

Use this only after the user explicitly chooses the Admin SOP and the queue is
blocked or the user intentionally selects the governed bypass. First prove
that the active GitHub actor is present in the live ruleset's bypass-actor list
for protected pull-request and merge-queue operations, then verify the live
ruleset and all exact-head preconditions above.

Only then may the configured bypass actor run:

```bash
gh pr merge <number> --repo hushh-labs/hushh_Tech_website \
  --admin --merge --match-head-commit <head-sha>
```

Report this as an **Admin queue bypass**. It is not merge-queue execution, and
it does not claim that `Queue Validation` ran. Monitor `Main Post-Merge Smoke`
for the landed `main` SHA before any deployment.

## 5. Promote the landed SHA

Resolve the SHA from the merged `main` ref after the merge; never infer it from
the PR head or a local checkout:

```bash
gh api repos/hushh-labs/hushh_Tech_website/commits/main --jq .sha
```

Require `Main Post-Merge Smoke Gate` to be successful for that exact SHA.

### UAT

Dispatch the governed workflow from `main` with the exact landed SHA:

```bash
gh workflow run deploy-uat.yml --repo hushh-labs/hushh_Tech_website \
  --ref main -f sha=<landed-main-sha>
```

Monitor the run to terminal success. Record the requested SHA, Cloud Run
revision, image digest, traffic, OAuth smoke, and Sensitive NDA Gate result.

### Production

Production is a separate, explicit promotion and requires its configured
deployment-environment reviewer. Dispatch only the approved landed SHA:

```bash
gh workflow run deploy-prod.yml --repo hushh-labs/hushh_Tech_website \
  --ref main -f sha=<approved-main-sha>
```

The workflow must pass its `Main Post-Merge Smoke Gate`, exact-SHA check, and
the `Production – hushh-tech` environment approval before Cloud Run traffic
changes. A UAT success does not authorize production.

## 6. Community Firestore synchronization

When the landed SHA includes `scripts/community/sync-community-firestore.mjs`
and production has `COMMUNITY_CONTENT_BACKEND=gcp`, the container deploy alone
does not update authoritative community content. Run the sync against the
target project after the production deploy:

```bash
npm run community:sync-firestore -- --project hushh-tech-prod
npm run community:sync-firestore -- --project hushh-tech-prod --apply
```

The first command is a dry run. Inspect its plan and verify the production
deployer identity has the required Firestore permissions before applying it.
Never substitute a personal ADC, UAT service account, or a guessed project.
Record the plan, applied document count, and resulting content verification.

## 7. Close-out evidence

The release record must state:

- PR number, exact PR head, landed `main` SHA, and whether the path was merge
  queue or Admin bypass;
- Queue Validation and Main Post-Merge Smoke run links and conclusions;
- UAT and production workflow run links, requested/resolved SHA, scope,
  revision, image digest, traffic, and live smoke evidence;
- Firestore dry-run/apply evidence when the community backend uses GCP; and
- any remaining reviewer, environment, IAM, or rollback blocker.

If a required review, environment approval, exact-SHA proof, or production IAM
check is unavailable, stop at that state and report it. Do not repair traffic
with an ad hoc `gcloud run deploy` or `update-traffic` command.
