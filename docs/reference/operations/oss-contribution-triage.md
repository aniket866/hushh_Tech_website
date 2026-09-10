# OSS Contribution Triage

This playbook defines how maintainers should review open-source pull requests after the agent and CI lanes run.

## Inputs to read before deciding

1. PR title and description
2. `Signalkeeper Preflight` walkthrough for changed surfaces, claimed validation, and fork/conflict state
3. changed files and affected surface
4. `PR Policy Gate` status so you know whether the reviewer and checklist sources were actually grounded
5. `Hushh Signalkeeper` findings
6. `Semantic PR Guard` findings
7. `Cloud Build Status Gate` / `CI Status Gate` status
8. whether the PR comes from a fork and whether full checks actually ran

## Maintainer decision flow

1. Confirm the owning surface with [`repo-context`](../../../.codex/skills/repo-context/SKILL.md) if the domain is unclear.
2. Ask [`repo-operations`](../../../.codex/skills/repo-operations/SKILL.md) whether the PR-check surface is complete and trustworthy.
3. Ask [`quality-contracts`](../../../.codex/skills/quality-contracts/SKILL.md) which proof is authoritative for the changed behavior.
4. Ask [`security-audit`](../../../.codex/skills/security-audit/SKILL.md) whether auth, env, secret, or deployment risk makes maintainer patching unsafe.
5. If the PR touches auth, env, deploy, API, or data-contract surfaces and the first-pass review is ambiguous, trigger `/compliance` before finalizing the bucket.
6. Pick one bucket and document the reason:
   - `Merge`
   - `Patch-and-merge`
   - `Request changes`
   - `Discard/close`

If doing this manually without the skill system, read these in order:

1. [CI Governance](./ci-governance.md)
2. [PR Decision Rubric](./pr-decision-rubric.md)
3. [PR Impact Checklist](../quality/pr-impact-checklist.md)

## When maintainer patching is allowed

Maintainer patching is allowed only when:

1. the PR is directionally correct
2. the fix is small and local
3. the fix does not change author intent
4. the required blocking checks can be rerun afterward
5. advisory lanes (`Signalkeeper Preflight`, `Hushh Signalkeeper`, `Semantic PR Guard`) do not show unresolved high-risk findings

## When maintainer patching is not allowed

Do not patch-and-merge when the PR touches:

1. auth/session correctness
2. env or secret wiring
3. deploy or CI governance
4. public API contract behavior
5. broad mixed-scope logic that needs the contributor to rework intent

## Progressive-enforcement note

Use `Semantic PR Guard` as an advisory-first signal. Treat it as a routing aid and early warning lane now; only convert a semantic check into blocking merge policy after it proves signal over real PR traffic.

## Decision note template

Use this minimum maintainer note format:

```md
Bucket: <Merge | Patch-and-merge | Request changes | Discard/close>
Reason: <one concise explanation>
Risk level: <low | medium | high>
Checks: <ran / missing / blocked>
Patch allowed: <yes | no>
Next action: <merge | maintainer patch | contributor update | close>
```
