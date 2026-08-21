# Contributing

Thanks for contributing to Hushh Tech Website.

All contributions are accepted under the Apache License, Version 2.0.

## Rustic Phase 2 contribution pause

General open-source contributions and feature requests are paused during Rustic Phase 2. The public community lane is now reproducible bug reporting through GitHub Issues.

- Use the Phase 2 bug report form for public bugs.
- Do not open public issues for security vulnerabilities, privacy issues, secret leaks, or exploit reports. Follow [SECURITY.md](SECURITY.md).
- Impact points are awarded for accepted bug reports only after maintainers verify that the bug is officially resolved.
- External bug-fix PRs are invite-only. A contributor PR must link an accepted issue with `Fixes #123`, `Closes #123`, or `Resolves #123`, and that issue must carry both `phase2:accepted` and `phase2:invited-pr`.
- Normal DCO, CI, CODEOWNERS, and maintainer review gates still apply.

See [Rustic Phase 2 Bug Impact Workflow](docs/reference/operations/rustic-phase-2-bug-impact.md).

## Before you start

- Read [README.md](README.md) for the repo layout.
- Do not commit secrets, keys, `.env` files, `.p8` files, or service-account JSON.
- Treat GCP Secret Manager as the production source of truth for sensitive values.
- Assume this repo is a public wrapper around production systems, not the source of truth for private infrastructure state.

## Local setup

```bash
npm ci
npm run test
npm run env:check
npm run lint:ci
npm run security:gitleaks
```

Use these additional checks when you are touching repo-health or security-sensitive paths:

```bash
npm run security:pre-commit
npm run security:audit
```

## Branching and pull requests

- During Rustic Phase 2, do not open unsolicited external PRs. Report the bug first and wait for maintainer invitation if a contributor PR is appropriate.
- Do not push directly to `main`.
- Do not push directly to `develop`.
- Create a topic branch from `main`.
- Keep pull requests focused and small enough to review.
- Explain what changed, why it changed, and how you validated it.
- Sign every commit with DCO using `git commit -s`.
- Every PR commit must contain a `Signed-off-by: Your Name <email>` trailer.
- Protected branches require an approving review from `@ankitkumarsingh1702`, unless an approved ruleset bypass actor (`@ankitkumarsingh1702` or `@Jhumma-hushh`) uses the protected-branch PR bypass.
- CODEOWNERS automatically routes PRs to the default maintainer.
- AI review comments help surface risk, but they do not replace human approval.
- The first automated review is powered by Qodo PR Agent on Gemini and is expected to comment on risky changes before maintainer review.
- PR Agent auto-reviews PRs on open, sync, review-requested, and ready-for-review events; maintainers can also trigger follow-up review with a `/review` comment.
- Re-trigger `/review` after a substantial PR update, after resolving requested changes, or when you want a fresh Gemini pass on the latest diff before maintainer review.
- First-time or fork contributors may need maintainer approval before code-executing workflows can run.

Maintainers triage PRs using an explicit decision rubric:

1. `Merge`
2. `Patch-and-merge`
3. `Request changes`
4. `Discard/close`

Reference docs:

- [Operations Reference](docs/reference/operations/README.md)
- [Quality Reference](docs/reference/quality/README.md)
- [Project Context Map](docs/project_context_map.md)

Example:

```bash
git commit -s -m "feat: harden governed CI pipeline"
```

## What maintainers expect

- Keep changes focused. Do not mix product UX, infra risk, and repo policy work into one PR.
- New runtime code should live in the existing repo structure instead of adding ad hoc root files.
- Do not add new public examples or docs that teach browser-visible vendor secret usage.
- Server-side secret usage should stay behind API routes or maintainer-controlled runtime config.
- Legacy Supabase database changes go through `supabase/migrations/` with timestamped files.
- GCP cutover contracts belong in `migration/` and must stay plan-only until a governed target workflow is authorized.
- If your change affects deploy, auth, wallets, or vendor integrations, document the operational impact clearly in the PR.

## Validation

At minimum, run the narrowest relevant checks for your change. Examples:

- `npm run test`
- `npx tsc --noEmit`
- `npm run build:web`
- `npm run env:check`
- `npm run lint:ci`
- `npm run security:gitleaks`
- `npm run security:pre-commit`

## Security issues

Do not file public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
