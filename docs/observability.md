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

Production is the project **`hushh-tech-prod`**, host `hushhtech.com`, Cloud Run
service `hushh-tech-website`. It has none of this yet — the stack above is UAT
only, which is backwards: the unmonitored project is the one the public reads.

`hushh-tech` is a *different* project and returns 403 to the operator key. An
earlier note in this repo read that 403 as "production is out of reach"; it is
not, and nothing should rely on that credential as a boundary. `config.json`
carried `hushh-tech` as the prod project until this was corrected, so `--env
prod` would have failed with that same 403 and looked like a permissions wall
rather than a typo.

```bash
node scripts/gcp/observability/apply-observability.mjs --env prod --email <address>          # plan
node scripts/gcp/observability/apply-observability.mjs --env prod --email <address> --apply
```

Run the plan and read the diff before applying. The same ten-minute log-metric
delay applies, so expect exit 2 on the first apply and run it again.

The plan is every-object-creates, because production holds zero notification
channels, zero log metrics, zero uptime checks and zero alert policies:

```
  create  notification channel <address>
  create  log metric community_static_fallback
  create  log metric community_detail_fallback
  create  log metric community_pagination_truncated
  create  log metric community_version_lookup_fallback
  create  uptime check release identity (/api/release)
  create  uptime check community content (/api/community/posts)
  skip    alert uptime check failing (no uptime checks yet — re-run with --apply)
  skip    alert content system degraded — <see below>
  create  alert community index truncated
  create  alert server errors elevated
  create  alert latency p95 above 3s
  create  alert instance count at ceiling
```

Both content matchers were checked against the live host first, because an
uptime check created against content that is not there is an alert that fires
the moment it exists: `/api/release` returns `"status":"ok"` and
`/api/community/posts` returns 129 posts carrying `"slug"`.

### One alert is deliberately not created on production

`hushh-tech-prod` has **no Firestore `(default)` database** — the API returns an
empty database list, not a permission error. Every community read therefore
falls back to the committed snapshot, which is production's content system
working as designed. `community_static_fallback` is consequently non-zero
continuously, and the *content system degraded* policy keyed on it would fire
forever.

An alert whose condition is the environment's normal operating state is worse
than no alert: it trains everyone to mute the channel, and the next real page
goes unread. So `config.json` names it in `skipEnvironments` with the reason,
and `apply-observability.mjs` prints the skip in the plan — an exclusion stated
out loud rather than a silent gap. Production's equivalent coverage is the
content-matching uptime check on `/api/community/posts` plus the 5xx alert.
Delete that key the day production gets a Firestore database.

The three remaining log metrics are still created on production. They cost
nothing, and `community_pagination_truncated` in particular is a genuine
never-should-happen there.

## Verifying it reports

```bash
node scripts/gcp/observability/apply-observability.mjs --email you@example.com   # plan is empty
```

and query the series directly — `run.googleapis.com/request_count`,
`run.googleapis.com/request_latencies`, `run.googleapis.com/container/instance_count`, and
`logging.googleapis.com/user/community_static_fallback`.
