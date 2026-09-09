---
name: observability
description: >-
  Use when Hushh Tech monitoring, alerting, uptime checks, or log-based metrics
  come up — adding or changing an alert, extending the stack to production,
  responding to an alert that fired, or answering "would we even know if this
  broke?". Trigger on Cloud Monitoring, alert policies, uptime checks,
  notification channels, log-based metrics, SLOs, p95 latency, 5xx rates, or a
  Cloud Run instance ceiling. Covers what is declared, how to apply it, and how
  to read each alert when it fires.
---

# Observability for hushh-tech-uat / hushh-tech

Everything is declared in `scripts/gcp/observability/config.json` and applied by
`scripts/gcp/observability/apply-observability.mjs`. Idempotent, keyed on display
name, so a re-run is a diff and production is a flag rather than a rewrite.

```bash
npm run obs:plan                                   # dry run against UAT
npm run obs:apply -- --email you@example.com
node scripts/gcp/observability/apply-observability.mjs --env prod --email you@example.com --apply
```

A newly created log-based metric takes up to ten minutes to become queryable by
Monitoring. An alert referencing one is deferred on the first run and created on
the second; the script says so and exits **2** rather than failing the apply.
Exit 2 means "run it again in ten minutes", not "it broke".

## The failure this stack exists for

`listGcpPosts()` falls back to the committed snapshot whenever a Firestore read
throws, and `getCommunityPost()` does the same. Both log and carry on. That is
the right runtime behaviour — a reader gets content rather than an error — and it
means **a degraded content system is completely silent**: the site serves stale
posts behind a perfectly healthy `200`, and no status-code check will ever see
it.

Four log-based metrics turn those log lines into signal:

| metric | what it means |
| --- | --- |
| `community_static_fallback` | the index is serving the committed snapshot; readers see stale content |
| `community_detail_fallback` | a post detail fell back the same way |
| `community_pagination_truncated` | the page-token guard tripped; the index is missing posts |
| `community_version_lookup_fallback` | a superseded-edition lookup fell back, so a canonical may forward to the wrong edition |

Both uptime checks are **content-matching**, for the same reason: a status check
passes on a `200` carrying an empty list, which is exactly what the fallback path
produces. `/api/release` must contain `"status":"ok"`; `/api/community/posts`
must contain `"slug"`.

## Reading an alert when it fires

- **Uptime failure** — the host is not answering, or is answering without the
  expected content. Check the revision first: a bad deploy that dropped env vars
  presents this way.
- **Content system degraded** — Firestore reads are failing. The site is up and
  serving stale content. Do not treat as low priority because nothing is 500ing.
- **Community index truncated** — pagination guard tripped. The index is missing
  posts; check `listAllDocuments()` and the 50-page ceiling.
- **5xx elevated / p95 above 3s** — ordinary application alerts.
- **Instance count at ceiling** — the service runs `max-instances=3` and deck
  imagery streams **through the application** rather than a CDN. A busy deck page
  issues one request per card image, each holding an instance for the transfer.
  **The fix is a CDN in front of `/api/community/assets`, not a bigger instance
  ceiling.** Raising instances buys time and hides the cause.

## Gotchas that cost time once already

- Cloud Monitoring accepts only `COMPARISON_LT` and `COMPARISON_GT` for an alert
  condition. `COMPARISON_GTE` and `COMPARISON_GE` are both rejected. Every
  threshold in `config.json` is therefore a strict "more than" and is written
  that way.
- Production is the project `hushh-tech-prod`. `hushh-tech` is a different
  project and returns 403 — do not read a 403 there as "production is protected".
  The operator key reads `hushh-tech-prod` fine, so `--env prod` is expected to
  work; it has not been applied yet, so run it as a plan first and read the diff.

Full write-up, including what existed before (nothing), is in
`docs/observability.md`.
