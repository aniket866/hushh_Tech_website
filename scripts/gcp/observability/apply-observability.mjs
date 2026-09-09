#!/usr/bin/env node
/**
 * Creates the monitoring this project did not have.
 *
 * Before this, hushh-tech-uat held zero uptime checks, zero alert policies, zero notification
 * channels and zero log-based metrics. Nothing would have told anyone that the site was down, that
 * latency had collapsed, or — the case that actually matters here — that Firestore reads were
 * failing and every visitor was being served a stale snapshot behind a perfectly healthy 200.
 *
 * Everything is defined in config.json and applied by displayName, so a re-run is a diff rather
 * than a duplicate, and pointing this at prod is a flag rather than a rewrite.
 *
 * Usage:
 *   node scripts/gcp/observability/apply-observability.mjs                       # dry run, UAT
 *   node scripts/gcp/observability/apply-observability.mjs --apply
 *   node scripts/gcp/observability/apply-observability.mjs --env prod --apply
 *   node scripts/gcp/observability/apply-observability.mjs --email ops@example.com --apply
 *   node scripts/gcp/observability/apply-observability.mjs --check               # report only
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { api } from "../../deploy/gcp-auth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
void root;

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith("--")) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : (i += 1, next);
}

const ENV = typeof args.env === "string" ? args.env : "uat";
const APPLY = Boolean(args.apply);
const environment = config.environments[ENV];
if (!environment) {
  console.error(`apply-observability: no environment "${ENV}" in config.json`);
  process.exit(1);
}
const { project: PROJECT, host: HOST } = environment;
const SERVICE = config.service;
const PREFIX = `[${ENV}] hushh-tech-website`;

const MONITORING = `https://monitoring.googleapis.com/v3/projects/${PROJECT}`;
const LOGGING = `https://logging.googleapis.com/v2/projects/${PROJECT}`;

const plan = [];
const note = (verb, what) => {
  plan.push(`${verb.padEnd(7)} ${what}`);
  console.log(`  ${verb.padEnd(7)} ${what}`);
};

/** Cloud Run logs from this service only, so a metric cannot be tripped by an unrelated workload. */
const runFilter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}"`;

// ---------------------------------------------------------------------------------------------
// Notification channel
// ---------------------------------------------------------------------------------------------

/**
 * Alerts with nowhere to go are decoration. One email channel, reused by every policy; pass
 * --email to point it somewhere else, or --no-channel to create the policies unattached.
 */
const ensureChannel = async (email) => {
  if (!email) return null;
  const displayName = `${PREFIX} alerts`;
  const existing = (await api(`${MONITORING}/notificationChannels`)).notificationChannels || [];
  const found = existing.find((channel) => channel.displayName === displayName);
  if (found) {
    if (found.labels?.email_address !== email) {
      note("update", `notification channel -> ${email}`);
      if (APPLY) {
        await api(`https://monitoring.googleapis.com/v3/${found.name}?updateMask=labels`, {
          method: "PATCH",
          body: { labels: { email_address: email } },
        });
      }
    } else {
      note("ok", `notification channel ${email}`);
    }
    return found.name;
  }
  note("create", `notification channel ${email}`);
  if (!APPLY) return `projects/${PROJECT}/notificationChannels/PENDING`;
  const created = await api(`${MONITORING}/notificationChannels`, {
    method: "POST",
    body: { type: "email", displayName, description: "Alerts for the HushhTech web service.", labels: { email_address: email }, enabled: true },
  });
  return created.name;
};

// ---------------------------------------------------------------------------------------------
// Log-based metrics
// ---------------------------------------------------------------------------------------------

const ensureLogMetrics = async () => {
  const existing = (await api(`${LOGGING}/metrics`)).metrics || [];
  const byName = new Map(existing.map((metric) => [metric.name, metric]));

  for (const definition of config.logMetrics) {
    // The runtime writes these through console.error, which Cloud Run surfaces as textPayload on
    // a plain log line rather than a structured jsonPayload.
    const filter = `${runFilter} AND severity>=ERROR AND textPayload:"${definition.match}"`;
    const body = { name: definition.name, description: definition.description, filter };
    const found = byName.get(definition.name);
    if (!found) {
      note("create", `log metric ${definition.name}`);
      if (APPLY) await api(`${LOGGING}/metrics`, { method: "POST", body });
    } else if (found.filter !== filter || found.description !== definition.description) {
      note("update", `log metric ${definition.name}`);
      if (APPLY) await api(`${LOGGING}/metrics/${definition.name}`, { method: "PUT", body });
    } else {
      note("ok", `log metric ${definition.name}`);
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Uptime checks
// ---------------------------------------------------------------------------------------------

const ensureUptimeChecks = async () => {
  const existing = (await api(`${MONITORING}/uptimeCheckConfigs`)).uptimeCheckConfigs || [];
  const names = new Map();

  for (const check of config.uptimeChecks) {
    const displayName = `${PREFIX} ${check.name}`;
    const body = {
      displayName,
      monitoredResource: { type: "uptime_url", labels: { project_id: PROJECT, host: HOST } },
      httpCheck: { path: check.path, port: 443, useSsl: true, validateSsl: true, requestMethod: "GET" },
      period: "300s",
      timeout: "10s",
      // A status check alone would pass on a 200 carrying an empty list, which is exactly the
      // failure mode the static-snapshot fallback produces.
      contentMatchers: [{ content: check.contains, matcher: "CONTAINS_STRING" }],
      selectedRegions: ["USA_OREGON", "EUROPE", "ASIA_PACIFIC"],
    };
    const found = existing.find((entry) => entry.displayName === displayName);
    if (!found) {
      note("create", `uptime check ${check.name} (${check.path})`);
      if (APPLY) {
        const created = await api(`${MONITORING}/uptimeCheckConfigs`, { method: "POST", body });
        names.set(check.name, created.name.split("/").pop());
      }
    } else {
      note("ok", `uptime check ${check.name}`);
      names.set(check.name, found.name.split("/").pop());
    }
  }
  return names;
};

// ---------------------------------------------------------------------------------------------
// Alert policies
// ---------------------------------------------------------------------------------------------

const conditionFor = (alert, uptimeIds) => {
  const base = { displayName: alert.name };
  const duration = `${alert.durationSeconds}s`;

  if (alert.kind === "uptime") {
    return [...uptimeIds.values()].map((id) => ({
      displayName: `${alert.name} (${id})`,
      conditionThreshold: {
        filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.labels.check_id="${id}"`,
        aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_FRACTION_TRUE" }],
        comparison: "COMPARISON_LT",
        thresholdValue: 0.5,
        duration,
        trigger: { count: 1 },
      },
    }));
  }

  if (alert.kind === "logMetric") {
    return [{
      ...base,
      conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${alert.metric}" AND resource.type="cloud_run_revision"`,
        aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
        comparison: "COMPARISON_GT",
        thresholdValue: alert.threshold,
        duration,
        trigger: { count: 1 },
      },
    }];
  }

  if (alert.kind === "runLatency") {
    return [{
      ...base,
      conditionThreshold: {
        filter: `metric.type="${alert.metric}" AND ${runFilter}`,
        aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_PERCENTILE_95", crossSeriesReducer: "REDUCE_MAX" }],
        comparison: "COMPARISON_GT",
        thresholdValue: alert.threshold,
        duration,
        trigger: { count: 1 },
      },
    }];
  }

  const filter = alert.responseCodeClass
    ? `metric.type="${alert.metric}" AND ${runFilter} AND metric.labels.response_code_class="${alert.responseCodeClass}"`
    : `metric.type="${alert.metric}" AND ${runFilter}`;
  return [{
    ...base,
    conditionThreshold: {
      filter,
      aggregations: [{
        alignmentPeriod: "300s",
        perSeriesAligner: alert.metric.includes("instance_count") ? "ALIGN_MEAN" : "ALIGN_SUM",
        crossSeriesReducer: alert.metric.includes("instance_count") ? "REDUCE_MAX" : "REDUCE_SUM",
      }],
      // Monitoring accepts only COMPARISON_LT and COMPARISON_GT, so every threshold here is a
      // strict "more than" and config.json states the values that way.
      comparison: "COMPARISON_GT",
      thresholdValue: alert.threshold,
      duration,
      trigger: { count: 1 },
    },
  }];
};

const deferred = [];

const ensureAlerts = async (channel, uptimeIds) => {
  const existing = (await api(`${MONITORING}/alertPolicies`)).alertPolicies || [];

  for (const alert of config.alerts) {
    const displayName = `${PREFIX} — ${alert.name}`;
    const conditions = conditionFor(alert, uptimeIds);
    if (!conditions.length) {
      note("skip", `alert ${alert.name} (no uptime checks yet — re-run with --apply)`);
      continue;
    }
    const body = {
      displayName,
      combiner: "OR",
      enabled: true,
      conditions,
      documentation: { content: alert.documentation, mimeType: "text/markdown" },
      notificationChannels: channel ? [channel] : [],
    };
    const found = existing.find((policy) => policy.displayName === displayName);
    try {
      if (!found) {
        note("create", `alert ${alert.name}`);
        if (APPLY) await api(`${MONITORING}/alertPolicies`, { method: "POST", body });
      } else {
        note("update", `alert ${alert.name}`);
        if (APPLY) {
          await api(
            `https://monitoring.googleapis.com/v3/${found.name}?updateMask=displayName,combiner,enabled,conditions,documentation,notificationChannels`,
            { method: "PATCH", body },
          );
        }
      }
    } catch (error) {
      // A log-based metric takes up to ten minutes to become queryable by Monitoring, so a policy
      // referencing one created moments ago is rejected. That is a timing fact, not a failure:
      // record it and let the rest of the run finish rather than aborting halfway through.
      if (error.status === 404 && /Cannot find metric/.test(error.bodyText || "")) {
        deferred.push(alert.name);
        note("defer", `alert ${alert.name} (metric not queryable yet)`);
        continue;
      }
      throw error;
    }
  }
};

// ---------------------------------------------------------------------------------------------

const main = async () => {
  console.log(`${APPLY ? "applying" : "dry run"} — project ${PROJECT}, host ${HOST}\n`);

  const email = args["no-channel"] ? "" : (typeof args.email === "string" ? args.email : config.alertEmail || "");
  if (!email && !args["no-channel"]) {
    console.error("apply-observability: pass --email <address> (or --no-channel to skip)\n");
    process.exit(1);
  }

  const channel = await ensureChannel(email);
  await ensureLogMetrics();
  const uptimeIds = await ensureUptimeChecks();
  await ensureAlerts(channel, uptimeIds);

  console.log(`\n${plan.length} object(s) ${APPLY ? "applied" : "planned"}`);
  if (!APPLY) console.log("re-run with --apply to write");
  if (deferred.length) {
    console.log(
      `\n${deferred.length} alert(s) deferred until their log metric is queryable ` +
        `(up to 10 minutes): ${deferred.join(", ")}.\nRe-run the same command to finish.`,
    );
    process.exitCode = 2;
  }
};

main().catch((error) => { console.error(error); process.exit(1); });
