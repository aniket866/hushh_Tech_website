# Hushh Tech Agent Context

This file is the canonical repository context for AI reviewers and coding agents.

Use it with:
- `.pr_agent.toml`
- `best_practices.md`
- `docs/project_context_map.md`
- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`

## Canonical Domains And Typo Recovery

Use these lower-case hostnames as the canonical spellings for production and UAT work:

| Surface | Production | UAT |
| --- | --- | --- |
| HushhTech web | `https://hushhtech.com` | `https://uat.hushhtech.com` |
| Hushh AI | `https://hushh.ai` | `https://uat.hushh.ai` |

- Treat `hashtag.com`, `hustag`, `hushtech`, `hushhTech.com`, and similar variants as likely prompt typos unless a checked-in file proves otherwise.
- For smoke tests, sitemap generation, robots generation, and deploy evidence, prefer the canonical domains above.
- If a user uses a misspelling while clearly referring to the HushhTech public site, resolve the task to `hushhtech.com` or `uat.hushhtech.com` based on the requested environment.

## Main-Branch Grounding

- Treat `main` as the repository source of truth for current behavior, runtime wiring, and CI policy.
- Review PRs against what is currently true on `main`, not only against what the PR description claims.
- If a behavior, service, or invariant is not visible in this repository, say that it is not shown here.
- Do not assume hidden infrastructure, hidden schemas, or hidden secrets unless a checked-in file explicitly proves them.

## Protected Branch Ownership

- GitHub repository rulesets are the enforcement surface for `main` and `develop`; classic branch protection is not the source of truth.
- `@hushh-labs/allowed-maintainers-to-approve` (team id `17036409`) is the required code-owner and approving-review team for protected changes. It has repository maintain access and is not a ruleset bypass actor.
- `@hushh-labs/main-emergency-bypass` (closed team id `19427424`) is the only bypass actor on the `Protect main branch` ruleset. It contains exactly `kushaltrivedi5`, `msainani`, `ankitkumarsingh1702`, `Jhumma-hushh`, `DamriaNeelesh`, and `RGlodAkshat`. Use it only for a documented emergency pull-request bypass; the normal path is independent maintainer approval followed by the merge queue.
- Other collaborators may push topic branches and open PRs, but they must not update protected refs, bypass protected-branch review rules, or merge protected-branch PRs.
- If live GitHub settings disagree with this section, treat the live settings as drift and repair the ruleset or repository access before relying on the merge path.

## What This Repository Owns

- Public Hushh web surfaces built with Vite + React under `src/`
- Shared frontend assets under `public/`
- API wrapper routes under `api/`
- The Cloud Run web runtime in `server.js`
- Supabase migrations, edge functions, and local assets under `supabase/`
- Standalone Cloud Run services under `cloud-run/`
- CI, PR validation, and deploy workflows under `.github/workflows/`
- Deterministic repository checks under `scripts/ci/` and `scripts/security/`

## What This Repository Does Not Prove

- Private production secrets
- Full internal service topology outside checked-in wrappers
- Any runtime that is not represented in `server.js`, `api/`, `cloud-run/`, or documented repo files
- Any claim that depends on hidden vendor configuration unless the repo explicitly documents it

## System Graph

Use these nodes and edges as the repository map.

### Nodes

1. `src/**`
   Frontend application routes, components, hooks, and browser-side services.

2. `src/auth/**` and `src/services/authentication/**`
   Session state, auth helpers, token handling, and login/logout lifecycle logic.

3. `src/services/**`
   Browser-side service layer that talks to same-origin APIs, Supabase, or vendor SDKs.

4. `api/**`
   Server-side request handlers that are loaded by `server.js` for Cloud Run runtime traffic.

5. `api/shared/**`
   Shared backend utilities and contract helpers used by API routes.

6. `server.js`
   The authoritative web runtime for Cloud Run: static asset serving, security headers, SPA fallback, and route registration.

7. `supabase/**`
   Migrations, edge functions, policies, and local Supabase assets that shape backend assumptions.

8. `cloud-run/**`
   Standalone service deployments that are related to, but separate from, the main web runtime.

9. `.github/workflows/**`
   Reviewer automation, PR validation, queue validation, smoke, and deploy orchestration.

10. `scripts/ci/**` and `scripts/security/**`
    Deterministic checks that define what CI actually proves.

### Edges

- `src/App.tsx` and route modules connect frontend URLs to `src/pages/**`.
- `src/pages/**` and `src/components/**` depend on `src/services/**` and `src/auth/**`.
- Browser-side services should reach sensitive backends through `api/**` or approved SDKs, not by exposing private secrets in the client.
- `server.js` lazy-loads `api/**` handlers and is the authoritative runtime route map for Cloud Run.
- `api/**` routes may depend on `api/shared/**`, Supabase, Google APIs, mail providers, wallet integrations, or other vendor services visible in the repo.
- `supabase/migrations/**` can change assumptions used by API routes, metrics, auth, and profile flows.
- `.github/workflows/**` provide the GitHub policy, queue-freshness, backup, and deploy lanes; the default pull-request code gate is the Cloud Build trigger defined by `cloudbuild.ci.yaml`.
- `cloud-run/**` services are separate deploy units and should not be assumed to share web runtime behavior unless the repo shows that linkage.

## Reviewer Routing By Surface

- If a PR touches `src/auth/**`, `src/services/authentication/**`, `api/**` auth paths, or env wiring, treat it as high-risk auth/runtime work.
- If a PR touches `server.js`, `.github/workflows/**`, `scripts/ci/**`, or deploy files, treat it as production-governance work.
- If a PR touches `supabase/**`, assume data-contract or migration impact until disproven.
- If a PR touches only docs or low-risk UI copy, keep review scope narrow and do not invent backend risk.

## Non-Negotiable Invariants

- Browser code must not expose non-public secrets.
- `VITE_*` variables are browser-visible; suspicious secret-like names in `VITE_*` are a real risk.
- Runtime route changes in `api/**` are incomplete if `server.js` route registration is not kept in sync.
- Auth, env, deploy, workflow, and migration changes need proof, not only intent.
- Cloud Build `hushh-tech-website-ci` is the authoritative pull-request code gate. The lightweight GitHub `PR Policy Gate` supplies pull-request metadata checks, and `Cloud Build Status Gate` joins both into the required `CI Status Gate` status. The full `PR Validation (GitHub backup)` workflow is manual-only. `Queue Validation` remains the merge-group freshness gate; `Signalkeeper Preflight`, `Hushh Signalkeeper`, and other advisory lanes do not replace these gates.

## High-Signal Validation Commands

Run or reference these when assessing proof:

```bash
npm test
npx tsc --noEmit
npm run build:web
npm run env:check
npm run lint:ci
npm run security:gitleaks
npm run security:audit
npm run smoke:ci
```

## Noise To Ignore By Default

- `dist/**`
- `node_modules/**`
- generated artifacts unless the PR intentionally changes checked-in generated output
- unrelated local docs or test reports that are not tracked by the repository

## Review Output Rules

- Report only findings that are grounded in the diff plus repository evidence.
- Cite the exact file and the concrete runtime or operational consequence.
- If broader architecture context is needed, use the graph above and `docs/project_context_map.md`.
- If evidence is missing, say so directly instead of filling the gap with a guess.
