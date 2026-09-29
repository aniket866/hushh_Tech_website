# HT-002 production redirect-session repair

Status: partial repair, not a completed login. No new deployment or provider configuration change is included in this patch.

## Evidence and scope

Production revision `hushh-tech-website-00224-jiw` serves commit `f69059076a7203ea5e37d232a3b97cc3f13d38b3`. The approved CSP release succeeded in Actions run 36573018210. Subsequent Google and Apple screenshots show `No redirect session found`; no successful application-account read is established by those screenshots.

Production still builds with a cross-origin Firebase auth domain, while UAT has a same-origin helper proxy. Firebase documents that redirect sign-in through a cross-origin iframe fails when third-party storage is blocked: https://firebase.google.com/docs/auth/web/redirect-best-practices (Option 3). This configuration defect is verified in the workflow and observed provider-start URL. Browser storage causality for each reported attempt remains to be confirmed by real-flow QA; the screenshot alone is not proof of that cause.

The patch reuses the existing transport with two fixed project/host/upstream tuples. Production maps only `hushhtech.com` to `hushh-tech-prod.firebaseapp.com`; UAT remains unchanged. Both Cloud and Firebase project IDs must match. TLS validation, host checks, raw Apple POST bytes, body limits, timeout handling, cookie scope, and omission of inbound cookies/authorization are retained. Session validation and account loading are not bypassed.

Production build authDomain becomes `hushhtech.com`. Startup verification checks the managed helper document, Google's exact callback, and Apple's exact callback plus `form_post` for login and signup. Startup evidence always reports `authenticated: false`.

## Release prerequisites and approval scope

Before release, inspect existing registrations and add only missing entries:

- Existing Google OAuth client: authorize `https://hushhtech.com/__/auth/handler`.
- Existing Apple Service ID: authorize domain `hushhtech.com` and return URL `https://hushhtech.com/__/auth/handler`.
- Firebase project `hushh-tech-prod`: confirm `hushhtech.com` is an authorized domain; add it only if absent.

Preserve every existing entry, including the previously saved Firebase-managed production return URLs. Do not recreate providers. These live changes require the user's exact approval; the previous approval covered the earlier Firebase-domain registrations and f690590 release only.

Use independent maintainer review, required Cloud Build/PR/queue gates, green main, then UAT verification and a separately approved pinned-main production release. Do not deploy this feature branch. Current base is `35ac108020e80f36c6aca97afc689978fa103e52`; relative to deployed f690590 it includes the signed-out UI copy change (3 additions, 26 deletions) in addition to this patch. The eventual merge SHA and full release delta must be reviewed before dispatch. Production data remains disabled. No new paid resources are introduced by this proxy extension.

Rollback: restore traffic to `hushh-tech-website-00224-jiw` at 100%; verify release identity and CSP. This restores the preceding known partial state, not working login. Preserve old provider entries so rollback remains possible. Remove only newly added registration entries if separately necessary after traffic rollback and verification.

## Required acceptance

For Google and Apple independently, on UAT and production: provider authorization, valid Firebase session, correct immutable-provider-to-application-account mapping, intended protected screen, refresh, logout, denied protected access, subsequent login. Test with third-party storage blocked and Safari, and Apple Hide My Email/returning-account behavior using approved accounts. Human credentials/MFA remain in provider UI. Never infer ownership from email alone.

The production `503 GCP_DATA_DISABLED` dependency remains separate and blocks complete application login even after redirect restoration. Its separate account-runtime/schema/identity proposal must pass ownership, deletion, conflict, restore and infrastructure gates before activation. No UAT data may substitute for production records.

## Local proof

CI/deploy toolchain: Node 20.19.0. The complete ten-file auth regression selection passes 210 tests with one existing skip. Typecheck, environment contract, web build, governed lint and gitleaks pass. Runtime fingerprint tool reports no drift; no approvals or activation guards were changed. Full-suite and hosted results are recorded in the PR and must remain explicit if incomplete or failing.

The earlier 183-versus-178 count reflected different test selections (12 omitted and 7 added), not deleted existing tests. This follow-up runs the full ten-file selection; nine added cases exercise production transport and Apple/build configuration. Existing auth tests are retained.
