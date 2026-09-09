# Observability

## What existed before

Nothing. `hushh-tech-uat` held zero uptime checks, zero alert policies, zero notification channels
and zero log-based metrics. Nothing would have reported that the site was down, that latency had
collapsed, or — the failure this system is actually prone to — that Firestore reads were failing
and every visitor was being served a stale snapshot behind a perfectly healthy `200`.

## The shape

Everything is declared in `scripts/gcp/observability/config.json` and applied by
`scripts/gcp/observability/apply-observability.mjs`, keyed on display name, so a re-run is a diff
and pointing it at production is a flag rather than a rewrite.

```bash
npm run obs:plan                    # dry run against UAT
npm run obs:apply -- --email you@example.com
node scripts/gcp/observability/apply-observability.mjs --env prod --email you@example.com --apply
```

A newly created log-based metric takes up to ten minutes to become queryable by Monitoring, so an
alert that references one is deferred on the first run and created on the second. The script says
so and exits 2 rather than failing the whole apply.

## The metrics that matter here

`listGcpPosts()` in `api/community/content-service.js` falls back to the committed snapshot
whenever a Firestore read throws, and `getCommunityPost()` does the same for a detail read. Both
log and carry on. That is the right runtime behaviour — a reader gets content rather than an
error — and it means a degraded content system is *completely silent*: the site serves stale posts
and looks healthy. These four log-based metrics turn those lines into a signal:

| metric | what it means |
|---|---|
| `community_static_fallback` | the community list is coming from the committed snapshot; readers see stale content |
| `community_detail_fallback` | a post detail fell back the same way |
| `community_pagination_truncated` | the page-token guard tripped; the index is missing posts |
| `community_version_lookup_fallback` | a superseded-edition lookup fell back, so a canonical may forward to the wrong edition |

## Uptime checks

Both check content, not just status. A plain status check would pass on a `200` carrying an empty
list, which is precisely what the fallback path can produce.

- `/api/release` must contain `"status":"ok"` — proves the application is serving, not merely that
  the load balancer answers.
- `/api/community/posts` must contain `"slug"` — proves the Firestore read path end to end.

## Alerts

Six policies, all wired to one email channel: uptime failure, content system degraded, community
index truncated, 5xx elevated, p95 latency above 3s, and instance count at its ceiling.

Cloud Monitoring accepts only `COMPARISON_LT` and `COMPARISON_GT` for an alert condition, so every
threshold is a strict "more than" and `config.json` states the values that way.

The instance-count alert is the one worth explaining: the service runs with `max-instances=3`, and
deck imagery streams *through the application* rather than a CDN. A busy deck page issues one
request per card image, each one occupying an instance for the length of the transfer. If that
alert fires, the fix is a CDN in front of `/api/community/assets`, not a bigger instance.

## Production

Production is the project **`hushh-tech-prod`**, host `hushhtech.com`. It has none
of this yet — the stack above is UAT only.

`hushh-tech` is a *different* project and returns 403 to the operator key. An
earlier note in this repo read that 403 as "production is out of reach"; it is
not, and nothing should rely on that credential as a boundary.

```bash
node scripts/gcp/observability/apply-observability.mjs --env prod --email <address>          # plan
node scripts/gcp/observability/apply-observability.mjs --env prod --email <address> --apply
```

Run the plan and read the diff before applying. The same ten-minute log-metric
delay applies, so expect exit 2 on the first apply and run it again.

## Verifying it reports

```bash
node scripts/gcp/observability/apply-observability.mjs --email you@example.com   # plan is empty
```

and query the series directly — `run.googleapis.com/request_count`,
`run.googleapis.com/request_latencies`, `run.googleapis.com/container/instance_count`, and
`logging.googleapis.com/user/community_static_fallback`.
