# Operations Reference

This folder holds the lightweight operations references for the first-wave OSS contribution triage system on this branch. Use these pages as quick lookup docs, then defer to the workflow pack, skill routing docs, and live GitHub workflow files for canonical behavior.

## Index

1. [OSS Contribution Triage](./oss-contribution-triage.md) for the maintainer decision flow and triage handoffs
2. [PR Decision Rubric](./pr-decision-rubric.md) for the four outcome buckets and patch-and-merge boundary
3. [CI Governance](./ci-governance.md) for Cloud Build's default PR gate, GitHub policy/backup lanes, and merge authority
4. [Admin Merge And Release SOP](./admin-release-sop.md) for the exact-head merge queue, Admin bypass, UAT, production, and Firestore release state machine
5. [Qodo Context Engine Rollout](./qodo-context-engine-rollout.md) for the hushhtech-first indexing and RAG adoption plan
6. [Skill Taxonomy](./skill-taxonomy.md) for the first-wave owner and spoke skill layout behind this flow
7. [Supabase Retirement Contract](./supabase-retirement-contract.md) for the
   frozen no-hybrid migration inventory and its blocking CI contract
8. [Supabase Native Cutover Gate](./supabase-native-cutover.md) for the fail-closed iOS and Android replacement-build requirement before Supabase deletion
9. [No-Hybrid Runtime Gate](./no-hybrid-runtime-gate.md) for the blocking source, artifact, native, workflow, and browser proof that the deployable product cannot reach Supabase
10. [Cloud Build CI](./cloudbuild-ci.md) for the default GCP pull-request code gate, GitHub policy bridge, and manual Actions backup

## Canonical workflow and governance

1. [Contribution Triage Playbook](../../../.codex/workflows/contribution-triage/PLAYBOOK.md) for the actual workflow pack and patch-and-merge guardrails
2. [Codex Skills README](../../../.codex/skills/README.md) for the first-wave skill fleet and routing model
3. [Project Context Map](../../project_context_map.md) for repo-surface ownership and default handoffs
4. [AGENTS](../../../AGENTS.md), [QODO](../../../QODO.MD), [.pr_agent.toml](../../../.pr_agent.toml), [.ai_config.toml](../../../.ai_config.toml), [pr_compliance_checklist.yaml](../../../pr_compliance_checklist.yaml), [.github/copilot-instructions.md](../../../.github/copilot-instructions.md), and [Hushh Signalkeeper custom agent](../../../.github/agents/hushh-signalkeeper.agent.md) for live reviewer grounding and GitHub-agent context
5. [README](../../../README.md), [CONTRIBUTING](../../../CONTRIBUTING.md), and [SECURITY](../../../SECURITY.md) for contributor-facing repo policy
6. [Signalkeeper Preflight](../../../.github/workflows/pr-intake.yml), [Hushh Signalkeeper](../../../.github/workflows/pr-agent.yml), [PR Policy Gate](../../../.github/workflows/pr-policy.yml), and [Cloud Build Status Gate](../../../.github/workflows/cloudbuild-status-gate.yml) for the live PR automation path
7. [Queue Validation](../../../.github/workflows/queue-validation.yml), [Main Post-Merge Smoke](../../../.github/workflows/main-post-merge-smoke.yml), [Deploy to UAT](../../../.github/workflows/deploy-uat.yml), and [Deploy to PROD](../../../.github/workflows/deploy-prod.yml) for merge freshness and release governance

## Suggested order

1. Start with [OSS Contribution Triage](./oss-contribution-triage.md).
2. Use [CI Governance](./ci-governance.md) to confirm which lanes are advisory, which checks block merge, and whether the sticky walkthrough / semantic guard story is complete.
3. Use [PR Decision Rubric](./pr-decision-rubric.md) to select exactly one maintainer outcome.
4. Refer to [Skill Taxonomy](./skill-taxonomy.md) and [Quality Reference](../quality/README.md) when routing follow-up work.
