# Hushh Tech Website

This repository is the public web and app wrapper for Hushh product surfaces. It contains the frontend, serverless wrapper routes, Supabase assets, tests, and documentation that shape the public experience around Hushh production services.

Repository URL: https://github.com/hushh-labs/hushh_Tech_website

## What this repo is

- A public wrapper and integration layer around Hushh web experiences
- A place for UI, UX, API wrapper, docs, test, and safe infrastructure contributions
- A production-backed repository that is maintained with protected branches, CODEOWNERS review, and maintainer-controlled deploys

## What this repo is not

- A source of production secrets, service-account keys, or private credentials
- A promise that every internal service or deployment detail is exposed here
- A safe place to commit `.env` files, `.p8` keys, service-account JSON, or vendor API keys

## Production model

- Production secrets belong in GCP Secret Manager or the minimal server-side secret store needed for a specific runtime
- `main` is protected and intended to move through pull requests, checks, and maintainer review
- `develop` is also protected and used for collaboration only; deployments promote from green `main` SHAs
- Public contributors should assume that production infra, credentials, and secret rotation stay maintainer-owned

## Governance

- `@ankitkumarsingh1702` is the default codeowner and required approving reviewer for protected branches, unless an approved ruleset bypass actor (`@ankitkumarsingh1702` or `@Jhumma-hushh`) uses the protected-branch PR bypass.
- automated CI, env checks, lint checks, and AI review are advisory or blocking based on repository rules
- DCO sign-off is expected on commits for contribution traceability
- deployments are gated by post-merge smoke and promoted by approved SHAs instead of raw branch pushes
- fork PRs may need maintainer approval before untrusted code-executing workflows can run

## Rustic Phase 2

General open-source contributions are paused during Rustic Phase 2. The public community lane is focused on reproducible bug reports through GitHub Issues.

- accepted and resolved bug reports can earn impact points
- feature requests and unsolicited external PRs are out of scope
- external bug-fix PRs are invite-only after a maintainer accepts the linked issue
- security vulnerabilities must be reported privately through [SECURITY.md](SECURITY.md)

See [Rustic Phase 2 Bug Impact Workflow](docs/reference/operations/rustic-phase-2-bug-impact.md).

## Maintainer PR triage

Maintainers now have an explicit OSS contribution triage flow on top of agent review and CI:

1. classify each incoming PR as `Merge`, `Patch-and-merge`, `Request changes`, or `Discard/close`
2. use the contribution-triage workflow and skill routing docs to decide whether maintainer patching is safe
3. route bounded follow-up work into the correct frontend, backend, docs, security, or repo-operations owner

See:

- [Operations Reference](docs/reference/operations/README.md)
- [Quality Reference](docs/reference/quality/README.md)
- [Project Context Map](docs/project_context_map.md)
- [Codex Skills](.codex/skills/README.md)

## Safe contribution areas

- frontend components and routes under `src/`
- wrapper APIs under `api/`
- docs, issue templates, and contributor tooling
- tests and smoke coverage
- safe build, CI, and repo-health improvements that do not expose or require secrets

## Maintainer-owned or sensitive areas

- secret rotation and vendor credential management
- deploy credentials and service-role material
- production GCP and Supabase configuration
- destructive git history rewrites and incident/security response

## Quick start

```bash
npm ci
npm run test
npm run lint:ci
npm run security:gitleaks
```

See:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SUPPORT.md](SUPPORT.md)
- [LICENSE](LICENSE)
- [NOTICE](NOTICE)

## Project layout

- `src/`: Active frontend code and route modules
- `api/`: Serverless wrapper endpoints
- `supabase/`: Edge functions, migrations, and local Supabase assets
- `cloud-run/`: Standalone service deployments
- `migration/`: Plan-only Supabase retirement and GCP data-contract artifacts
- `scripts/`: Operational and repo-maintenance scripts
- `docs/`: Architecture, runbooks, and contributor-facing documentation
- `tests/`: Vitest coverage and route-level verification
- `public/`: Static assets served directly by Vite

## Repo conventions

- Keep runtime app code in `src/`
- Keep timestamped DB changes in `supabase/migrations/`
- Keep historical or manual SQL in `supabase/manual-sql/`
- Keep repo-entrypoint files in the root; move product docs into `docs/`
- Prefer PR-sized, decision-clear changes over broad mixed diffs
- Follow Apache-2.0 contribution expectations for attribution, notice handling, and review traceability
- Use `git commit -s` so commit history carries a DCO sign-off
