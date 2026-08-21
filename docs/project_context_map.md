# Project Context Map

This file is the repo-routing map for the first-wave Hushhtech skill system.

## Primary maintained surfaces

| Surface | Purpose | Default owner skill |
| --- | --- | --- |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/reference/README.md` | contributor-facing repo policy and governance references | `docs-governance` |
| `.github/workflows`, `scripts/ci`, `scripts/security`, deploy wrapper scripts | PR checks, merge queue, smoke, deploy control, and repo-health tooling | `repo-operations` |
| `.codex/skills/README.md`, `docs/project_context_map.md`, `docs/reference/operations/skill-taxonomy.md` | skill routing and repo ownership map | `repo-context` |
| `src/**`, `public/**` | default frontend product surfaces | `frontend` |
| `src/components/ui`, `src/components/hushh-tech-*`, `src/theme`, `docs/reference/quality/design-system.md` | shared UI and design-system surfaces | `frontend-design-system` |
| `src/auth`, `src/resources/config`, auth/env/secret-sensitive `api/*` routes | auth, env, secret, and fail-closed risk escalation | `security-audit` |
| `api`, `api/shared`, `server.js`, `supabase/**`, `cloud-run/**` runtime code | backend runtime, API contracts, Supabase, and standalone service code | `backend` |
| `api/hushh-research-client.js`, `api/shared/hushhResearch*`, `src/auth`, `src/services/hushhResearch`, `docs/reference/architecture/hushh-research-uat-client.md` | UAT-only Hushh Research client boundary | `security-audit` |
| `tests`, `vitest.config.ts`, Playwright commands | proof selection and quality gates | `quality-contracts` |

## First-wave routing rules

1. If the request is "what do we do with this contributor PR?" start with `oss-contribution-triage`.
2. If the request is "which skill should own this repo surface?" start with `repo-context`.
3. If the request is "why are checks failing or not running?" use `repo-operations`.
4. If the request is "which tests prove this change?" use `quality-contracts`.
5. If the request is "is maintainer patching safe here?" use `security-audit` for auth, env, secrets, fail-closed behavior, and sensitive API risk.
6. If a PR touches multiple owner surfaces, start with `repo-context` and let the highest-risk surface win. Examples:
   - `docs` + `src` -> start with `repo-context`, usually hand off to `frontend` unless the change is pure governance text
   - `api` + `tests` -> start with `backend`, then pull in `quality-contracts` for proof
   - workflow + runtime code -> start with `repo-context`, then hand off to `repo-operations` if governance changes are material
