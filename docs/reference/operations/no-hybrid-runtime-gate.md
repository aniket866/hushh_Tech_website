# No-Hybrid Runtime Gate

`No-Hybrid Runtime Gate` is the blocking proof that a deployable Hushh Tech
artifact has no executable Supabase dependency. It is separate from the
retirement manifest: the manifest freezes what must be migrated, while this
gate proves that the serving path no longer reaches the source provider.

## What is scanned

- browser, API, Cloud Run, release-script, workflow, and native source
- direct production dependencies and environment bindings
- static, dynamic, aliased, and transitive imports
- encoded or concatenated provider hosts and environment names
- the exact primary and six secondary legacy project references, even without a host
- the generated `dist/` tree and native web-asset trees
- the final root Cloud Run image during `docker build`
- the Chromium network guard on five unauthenticated sample routes

The browser mechanism intercepts Hypertext Transfer Protocol (HTTP), EventSource,
and WebSocket traffic before it can leave the browser. A request to `supabase.co`
or any subdomain fails the gate. Service workers are disabled. Other third-party
requests are also blocked during this deterministic check, but do not count as
a provider violation.

This is not yet full browser acceptance. It does not enumerate every literal
and parameterized `App.tsx` route, and it has no authenticated session fixture.
`FULL_ROUTE_AND_AUTH_BROWSER_COVERAGE` therefore remains an intentional cutover
blocker. Clearing it requires checked-in full-route inventory, parameter
fixtures, and authenticated automation; changing policy booleans cannot clear
the blocker.

## Explicit non-runtime classifications

The reviewable policy is
`scripts/ci/no-hybrid-runtime-policy.json`. Only migration tooling, frozen
source archives, migration evidence, documentation archives, and automated
test evidence may be classified as non-runtime. The validator rejects a policy
that attempts to classify `src/`, `api/`, Cloud Run source, workflows, build
artifacts, or native source as evidence.

A runtime entrypoint that imports a classified file still fails. Classification
is not an executable allowlist.

## Commands

```bash
npm run migration:no-hybrid:source
npm run build:web
npm run migration:no-hybrid:check
npm run test:e2e:no-hybrid
```

`bash scripts/ci/orchestrate.sh no-hybrid` runs the four steps in order. The
same sequence is blocking in pull requests and the merge queue. It runs again
on landed `main`; UAT and production deploy workflows repeat source and final
artifact checks before Cloud authentication and Cloud Run deployment.

The two root Dockerfiles also run the artifact-only checker. Direct Cloud Build
or a local Docker build therefore cannot bypass the GitHub gate.

## Expected migration behavior

This control is fail closed. While executable Supabase imports, URLs, project
references, secrets, environment keys, SDK calls, deploy bindings, or the full
browser-coverage blocker remain, the command exits nonzero and writes
`tmp/ci/no-hybrid-runtime-report.json`. Do not baseline those violations.
Remove or port the executable dependency, complete the route/auth automation,
then rerun the gate.

The existing 112-function compatibility registry remains frozen and GCP-backed.
The gate verifies its count and keeps the retirement contract wired in pull
request, queue, and post-merge validation.
