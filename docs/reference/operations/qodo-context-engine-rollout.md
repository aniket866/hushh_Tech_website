# Qodo Context Engine Rollout

This is the Hushh Tech rollout plan for Qodo Context Engine and PR-review RAG. It is intentionally single-repo-first.

## Goal

Give `hushh_Tech_website` materially better repository-grounded review quality before widening scope to other Hushh repositories.

## Scope Order

1. `hushh-labs/hushh_Tech_website` only
2. validate review quality and reference quality on this repository
3. widen only after signal quality is proven

Do not start by indexing all Hushh repositories.

## Why single-repo first

Qodo’s RAG docs recommend keeping scope tight to reduce noise. For PR-review RAG, the default repository scope is the PR repository, which matches the Hushh Tech need here.

## Required prerequisites

Before enabling review-side RAG:

1. Qodo enterprise access with Context Engine / RAG available
2. single-tenant or on-prem setup for PR-review RAG
3. Context Engine infrastructure installed
4. PostgreSQL 17 with `pg_vector`
5. two databases:
   - `rag-indexer`
   - `metadata`
6. a GitHub org admin installs the read-only `Qodo RAG Indexer` app
7. the app is granted access to `hushh-labs/hushh_Tech_website` specifically, not all repositories

## Repo preparation

These files are now the grounding layer that should be merged to `main` first:

1. [AGENTS.md](../../../AGENTS.md)
2. [QODO.MD](../../../QODO.MD)
3. [.pr_agent.toml](../../../.pr_agent.toml)
4. [.ai_config.toml](../../../.ai_config.toml)
5. [pr_compliance_checklist.yaml](../../../pr_compliance_checklist.yaml)
6. [.github/copilot-instructions.md](../../../.github/copilot-instructions.md)
7. [.github/agents/hushh-signalkeeper.agent.md](../../../.github/agents/hushh-signalkeeper.agent.md)

Do not enable RAG against a stale default branch. Merge the grounding branch first.

## Hushhtech-first rollout phases

### Phase 0: Merge grounding and governance

Required outcome:

1. `main` contains the repo-root grounding files
2. `PR Policy Gate` blocks on reviewer grounding and `Cloud Build Status Gate` publishes the required `CI Status Gate`
3. GitHub Copilot cloud agent can read `.github/copilot-instructions.md` and the Hushh-specific custom agent profile

### Phase 1: Index only `hushh_Tech_website`

Required actions:

1. install `Qodo RAG Indexer` with access to `hushh-labs/hushh_Tech_website` only
2. confirm the repository is tagged/indexed in Context Engine
3. keep `.ai_config.toml` noise filters in place
4. avoid expanding to `all` repositories

### Phase 2: Turn on review-side RAG conservatively

Enable RAG only after indexing is healthy.

Use the repository-local scope first. Do not widen `rag_repo_list` beyond this repository yet.

Target configuration direction:

```toml
[rag_arguments]
enable_rag = true
```

If a repository list is configured later, start with:

```toml
[rag_arguments]
enable_rag = true
rag_repo_list = ["hushh-labs/hushh_Tech_website"]
```

### Phase 3: Validate evidence quality

Test these surfaces on real Hushh Tech PRs:

1. `/review`
2. `/ask`
3. `/context`
4. `Hushh Signalkeeper` comments

Accept only if the reviewer produces useful `References` / `Focus` with low noise and materially better grounding than diff-only review.

### Phase 4: Add PR History later

Only after repository-grounded RAG is stable:

1. enable or validate PR History for this repository
2. confirm relevance ranking is actually reducing false positives
3. keep this repo as the proving ground before indexing more Hushh repos

## Success criteria

The rollout is successful only if:

1. reviewer findings cite repository evidence more consistently
2. false-positive review noise drops on auth, env, API, CI, and deploy PRs
3. maintainers can inspect returned references and see why the reviewer made a claim
4. reference quality is good enough that widening scope will not dilute review quality

## Failure conditions

Stop the rollout or pause widening if:

1. RAG references are noisy or irrelevant
2. the reviewer starts inventing cross-repo dependencies that are not actually in scope
3. indexing quality is poor because too much non-production content is included
4. the team cannot distinguish advisory RAG output from deterministic CI gates

## Operational rules

1. Cloud Build `hushh-tech-website-ci` plus `Cloud Build Status Gate` remain the default merge authority
2. `Hushh Signalkeeper` remains advisory, even with RAG enabled
3. GitHub Copilot cloud agent instructions and Qodo reviewer grounding should stay aligned
4. update `AGENTS.md`, `QODO.MD`, `.github/copilot-instructions.md`, and `pr_compliance_checklist.yaml` whenever runtime topology or CI policy changes

## Expansion rule

Do not index additional Hushh repositories until `hushh_Tech_website` shows stable, high-signal review quality over real PR traffic.
