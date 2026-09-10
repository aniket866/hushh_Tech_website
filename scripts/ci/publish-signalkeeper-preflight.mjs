import fs from "node:fs";

const eventPath = process.env.GITHUB_EVENT_PATH || "";
const token = process.env.GITHUB_TOKEN || "";
const repository = process.env.GITHUB_REPOSITORY || "";
const reviewLaneName = process.env.REVIEW_LANE_NAME || "Hushh Signalkeeper";
const semanticGuardName = process.env.SEMANTIC_GUARD_NAME || "Semantic PR Guard";
const validationLaneName = "Cloud Build CI + PR Policy Gate";
const apiBaseUrl = trimTrailingSlash(process.env.GITHUB_API_URL || "https://api.github.com");
const validationChecks = String(process.env.PR_VALIDATION_CHECKS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!eventPath || !fs.existsSync(eventPath)) {
  console.error("GITHUB_EVENT_PATH is required.");
  process.exit(1);
}

if (!token) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(1);
}

if (!repository.includes("/")) {
  console.error("GITHUB_REPOSITORY must be set as owner/repo.");
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const prNumber = payload.pull_request?.number;

if (!prNumber) {
  console.error("This script only supports pull request events.");
  process.exit(1);
}

const [owner, repo] = repository.split("/");
const markers = ["<!-- codex-signalkeeper-preflight -->", "<!-- codex-pr-intake -->"];
const primaryMarker = markers[0];
const apiBase = `${apiBaseUrl}/repos/${owner}/${repo}`;
const summaryPath = process.env.GITHUB_STEP_SUMMARY || "";

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function sectionContent(markdown, heading) {
  const lines = String(markdown || "").split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return "";
  }

  const chunk = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      break;
    }
    chunk.push(lines[index]);
  }

  return chunk.join("\n").trim();
}

function extractBullets(section) {
  return String(section || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function keyedBullets(section) {
  return String(section || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .filter((line) => !/^- \[[ xX]\]/.test(line))
    .reduce((accumulator, line) => {
      const match = line.match(/^- ([^:]+):\s*(.*)$/);
      if (!match) {
        return accumulator;
      }

      accumulator[match[1].trim().toLowerCase()] = match[2].trim();
      return accumulator;
    }, {});
}

function checkedValidationItems(section) {
  return String(section || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^- \[[xX]\]/.test(line))
    .map((line) => line.replace(/^- \[[xX]\]\s*/, "").trim());
}

function hasLinkedIssue(text) {
  const value = String(text || "");
  return (
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+\b/i.test(value) ||
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i.test(value) ||
    /\b(?:linear|jira|ticket|issue)\b/i.test(value)
  );
}

function areaForPath(filePath) {
  if (
    /^src\/auth\//.test(filePath) ||
    /^src\/services\/authentication\//.test(filePath) ||
    /^src\/services\/runtime\//.test(filePath) ||
    /^src\/resources\/config\//.test(filePath)
  ) {
    return "Auth & Secrets";
  }

  if (
    /^api\//.test(filePath) ||
    /^server\.js$/.test(filePath) ||
    /^cloud-run\//.test(filePath) ||
    /^Dockerfile$/.test(filePath)
  ) {
    return "API & Runtime";
  }

  if (/^supabase\//.test(filePath)) {
    return "Data & Schema";
  }

  if (
    /^\.github\/workflows\//.test(filePath) ||
    /^scripts\/ci\//.test(filePath) ||
    /^vercel\.json$/.test(filePath) ||
    /^cloudbuild/.test(filePath)
  ) {
    return "CI & Deploy";
  }

  if (
    /^src\/pages\//.test(filePath) ||
    /^src\/components\//.test(filePath) ||
    /^src\/hooks\//.test(filePath) ||
    /^src\/theme\//.test(filePath) ||
    /^public\//.test(filePath)
  ) {
    return "Frontend UI";
  }

  if (
    /^tests\//.test(filePath) ||
    /(?:^|\/)(?:test|spec)\.[jt]sx?$/.test(filePath) ||
    /playwright/i.test(filePath)
  ) {
    return "Tests";
  }

  if (/^docs\//.test(filePath) || /\.md$/i.test(filePath)) {
    return "Docs";
  }

  return "Other";
}

function riskTagsForPath(filePath) {
  const tags = new Set();

  if (
    /^src\/auth\//.test(filePath) ||
    /^src\/services\/authentication\//.test(filePath) ||
    /^src\/resources\/config\//.test(filePath)
  ) {
    tags.add("auth");
    tags.add("security");
  }

  if (/^api\//.test(filePath) || /^server\.js$/.test(filePath) || /^cloud-run\//.test(filePath)) {
    tags.add("api");
    tags.add("runtime");
  }

  if (/^supabase\//.test(filePath)) {
    tags.add("schema");
    tags.add("deploy");
  }

  if (
    /^\.github\/workflows\//.test(filePath) ||
    /^scripts\/ci\//.test(filePath) ||
    /^Dockerfile$/.test(filePath) ||
    /^package(?:-lock)?\.json$/.test(filePath)
  ) {
    tags.add("deploy");
    tags.add("ci");
  }

  if (/^src\/pages\//.test(filePath) || /^src\/components\//.test(filePath)) {
    tags.add("ui");
  }

  return [...tags];
}

async function githubRequest(apiPath, options = {}) {
  const response = await fetch(`${apiBase}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "hushh-signalkeeper-preflight",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function paginate(apiPathFactory, maxPages = 10) {
  const results = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageData = await githubRequest(apiPathFactory(page));
    if (!Array.isArray(pageData) || pageData.length === 0) {
      break;
    }
    results.push(...pageData);
    if (pageData.length < 100) {
      break;
    }
  }
  return results;
}

function summarizeFiles(files) {
  const buckets = new Map();
  const riskTags = new Set();

  for (const file of files) {
    const filename = file.filename;
    const area = areaForPath(filename);
    const current = buckets.get(area) || { area, count: 0, samples: [] };
    current.count += 1;
    if (current.samples.length < 3) {
      current.samples.push(filename);
    }
    buckets.set(area, current);

    for (const tag of riskTagsForPath(filename)) {
      riskTags.add(tag);
    }
  }

  const areas = [...buckets.values()].sort((left, right) => right.count - left.count);
  return { areas, riskTags: [...riskTags].sort() };
}

function semanticHygieneSummary(body) {
  const summarySection = sectionContent(body, "## Summary");
  const validationSection = sectionContent(body, "## Validation");
  const notesSection = sectionContent(body, "## Notes");
  const summaryFields = keyedBullets(summarySection);
  const validationFields = keyedBullets(validationSection);
  const notesBullets = extractBullets(notesSection);
  const checkedItems = checkedValidationItems(validationSection);

  const deployDisclosure = notesBullets.some((item) =>
    /deployment|migration|env|rollback|none/i.test(item)
  );
  const reviewerCallout = notesBullets.some((item) => /@|codeowners|review/i.test(item));
  const smokeOrSecurityProof = checkedItems.some((item) =>
    /smoke|route|security|audit|env:check|env check/i.test(item)
  );

  return {
    hasLinkedIssue: hasLinkedIssue(body),
    deployDisclosure,
    reviewerCallout,
    checkedItems,
    smokeOrSecurityProof,
    summarySection,
    notesSection,
    linkedIssue: summaryFields["linked issue"] || "",
    acceptanceCriteria: summaryFields["acceptance criteria covered"] || "",
    riskArea: summaryFields["risk area touched"] || "",
    reviewerFocus: summaryFields["reviewer focus"] || "",
    ran: validationFields["ran"] || "",
    didNotRun: validationFields["did not run"] || "",
    reviewerShouldVerify: validationFields["reviewer should verify"] || "",
  };
}

function reviewerFocus(riskTags, hygiene, fileCount) {
  const focus = [];
  const risky = riskTags.some((tag) =>
    ["auth", "security", "api", "runtime", "deploy", "schema", "ci"].includes(tag)
  );

  if (risky && !hygiene.hasLinkedIssue) {
    focus.push("High-risk surfaces changed, but the PR body does not clearly link an issue or ticket.");
  }

  if (
    (riskTags.includes("deploy") || riskTags.includes("schema") || riskTags.includes("runtime")) &&
    !hygiene.deployDisclosure
  ) {
    focus.push("Runtime or deploy-sensitive files changed without a concrete deployment, env, migration, or rollback note.");
  }

  if (
    (riskTags.includes("auth") || riskTags.includes("security")) &&
    !/auth|secret|token|session|consent|identity/i.test(`${hygiene.summarySection}\n${hygiene.notesSection}`)
  ) {
    focus.push("Auth or secret-sensitive paths changed without an explicit auth/security callout in Summary or Notes.");
  }

  if ((riskTags.includes("api") || riskTags.includes("runtime") || riskTags.includes("deploy")) && !hygiene.smokeOrSecurityProof) {
    focus.push("Targeted route, smoke, env, or security proof is not marked complete in the Validation checklist.");
  }

  if (!hygiene.reviewerCallout && risky) {
    focus.push("Reviewer callouts are missing for a risky PR; route this early to the maintainer who owns the touched surface.");
  }

  if (fileCount > 40 || riskTags.length >= 4) {
    focus.push("The diff is broad enough that reviewers should sanity-check for mixed scope before treating it as patch-and-merge.");
  }

  return focus.slice(0, 4);
}

function validationAvailability(pr, isFork) {
  const mergeableState = pr.mergeable_state || "unknown";
  const hasConflicts = mergeableState === "dirty";
  const mergeabilityPending = ["unknown", null].includes(pr.mergeable_state);

  if (hasConflicts && isFork) {
    return {
      message:
        "Blocked for now: GitHub will not start `pull_request` workflows while the PR has merge conflicts, and forked PRs may still need maintainer approval after conflicts are resolved.",
      conflictNote:
        `GitHub currently reports merge conflicts on the PR merge branch. \`Signalkeeper Preflight\` still runs because it uses \`pull_request_target\`, but \`${validationLaneName}\` will not run until the conflicts are fixed.`,
    };
  }

  if (hasConflicts) {
    return {
      message:
        `Blocked for now: GitHub will not start \`pull_request\` workflows while the PR has merge conflicts. Resolve conflicts before expecting \`${validationLaneName}\` checks to appear.`,
      conflictNote:
        `GitHub currently reports merge conflicts on the PR merge branch. \`Signalkeeper Preflight\` still runs because it uses \`pull_request_target\`, but \`${validationLaneName}\` will not run until the conflicts are fixed.`,
    };
  }

  if (isFork) {
    return {
      message:
        "Waiting is possible: fork PRs may show only preflight and Signalkeeper output until a maintainer approves code-executing workflows.",
      conflictNote: "GitHub is not currently reporting merge conflicts for this PR.",
    };
  }

  if (mergeabilityPending) {
    return {
      message:
        `Mergeability is still being computed by GitHub. If the PR later shows conflicts, \`${validationLaneName}\` will wait until those conflicts are resolved.`,
      conflictNote:
        `GitHub has not finished computing mergeability yet. If conflicts appear, \`${validationLaneName}\` will wait until they are resolved.`,
    };
  }

  return {
    message: `\`${validationLaneName}\` should start automatically for this PR and report its check suite.`,
    conflictNote: "GitHub is not currently reporting merge conflicts for this PR.",
  };
}

function formatField(value, fallback = "_not stated_") {
  const normalized = String(value || "").trim();
  return normalized.length > 0 ? normalized : fallback;
}

function summarizeChecks(checkRuns) {
  const latestByName = new Map();
  for (const run of checkRuns) {
    const current = latestByName.get(run.name);
    if (
      !current ||
      new Date(run.started_at || run.completed_at || 0) >
        new Date(current.started_at || current.completed_at || 0)
    ) {
      latestByName.set(run.name, run);
    }
  }

  const visibleValidation = [];
  const missingValidation = [];
  for (const checkName of validationChecks) {
    const run = latestByName.get(checkName);
    if (run) {
      visibleValidation.push(`\`${checkName}\` (${run.conclusion || run.status || "reported"})`);
    } else {
      missingValidation.push(`\`${checkName}\``);
    }
  }

  const advisoryVisible = [];
  for (const checkName of ["Signalkeeper Preflight", reviewLaneName, semanticGuardName]) {
    const run = latestByName.get(checkName);
    if (run) {
      advisoryVisible.push(`\`${checkName}\` (${run.conclusion || run.status || "reported"})`);
    }
  }

  return { visibleValidation, missingValidation, advisoryVisible };
}

function writeSummary(markdown) {
  if (!summaryPath) {
    return;
  }
  fs.writeFileSync(summaryPath, `${markdown}\n`);
}

function warn(message) {
  console.warn(`::warning::${message}`);
}

const livePr = await githubRequest(`/pulls/${prNumber}`);
const files = await paginate((page) => `/pulls/${prNumber}/files?per_page=100&page=${page}`, 5);
const comments = await paginate((page) => `/issues/${prNumber}/comments?per_page=100&page=${page}`, 5);
const checkRunsResponse = await githubRequest(`/commits/${livePr.head.sha}/check-runs?per_page=100`);

const isFork = livePr.head.repo.full_name !== livePr.base.repo.full_name;
const repoScope = isFork ? "Fork PR" : "Same-repository PR";
const forkNote = isFork
  ? "This PR comes from a fork, so code-executing workflows may require maintainer approval before they can run."
  : "This PR comes from a branch in the base repository, so fork-approval gating does not apply.";
const availability = validationAvailability(livePr, isFork);
const changed = summarizeFiles(files);
const hygiene = semanticHygieneSummary(livePr.body || "");
const focus = reviewerFocus(changed.riskTags, hygiene, files.length);
const checks = summarizeChecks(checkRunsResponse.check_runs || []);
const areaLines = changed.areas.slice(0, 5).map(
  (area) =>
    `- ${area.area}: ${area.count} file${area.count === 1 ? "" : "s"} (${area.samples
      .map((sample) => `\`${sample}\``)
      .join(", ")})`
);
const semanticSignals = [
  `Linked issue: ${hygiene.hasLinkedIssue ? "present" : "missing or unclear"}`,
  `Deploy/env note: ${hygiene.deployDisclosure ? "present" : "missing or too vague"}`,
  `Reviewer callout: ${hygiene.reviewerCallout ? "present" : "missing"}`,
  `Targeted proof checked: ${hygiene.smokeOrSecurityProof ? "yes" : "not yet"}`,
];

const body = [
  primaryMarker,
  "## Signalkeeper Preflight",
  `- Scope: ${repoScope}`,
  `- Head: \`${livePr.head.label}\``,
  `- Base: \`${livePr.base.label}\``,
  "- This lane: comment-only `pull_request_target` guidance; it does not execute PR code.",
  `- AI first review: \`${reviewLaneName}\` is the advisory review lane and can be retriggered with \`/review\`.`,
  `- Advisory semantic guard: \`${semanticGuardName}\` runs in warning-first mode and is not yet part of the blocking merge gate.`,
  `- Merge check lane: \`${validationLaneName}\` is the authoritative code-executing lane plus the GitHub metadata gate.`,
  `- ${validationLaneName} checks: ${validationChecks.map((name) => `\`${name}\``).join(", ")}`,
  `- Current ${validationLaneName} availability: ${availability.message}`,
  `- Advisory checks currently visible: ${checks.advisoryVisible.length > 0 ? checks.advisoryVisible.join(", ") : "none detected yet"}`,
  `- Authoritative checks currently visible: ${checks.visibleValidation.length > 0 ? checks.visibleValidation.join(", ") : "none detected yet"}`,
  `- Missing authoritative checks on the current head SHA: ${checks.missingValidation.length > 0 ? checks.missingValidation.join(", ") : "none"}`,
  `- Fork safety: ${forkNote}`,
  `- Merge conflicts: ${availability.conflictNote}`,
  "- Deployments: `Deploy to UAT` and `Deploy to PROD` do not run on PRs.",
  "",
  "## Walkthrough",
  `- Files changed: ${files.length}`,
  `- Risk tags: ${changed.riskTags.length > 0 ? changed.riskTags.map((tag) => `\`${tag}\``).join(", ") : "`docs-only`"}`,
  ...areaLines,
  "",
  "## Author Intent",
  `- Linked issue: ${formatField(hygiene.linkedIssue)}`,
  `- Acceptance criteria: ${formatField(hygiene.acceptanceCriteria)}`,
  `- Risk area: ${formatField(hygiene.riskArea)}`,
  `- Reviewer focus from author: ${formatField(hygiene.reviewerFocus)}`,
  `- Completed checks claimed by author: ${hygiene.checkedItems.length > 0 ? hygiene.checkedItems.slice(0, 5).map((item) => `\`${item}\``).join(", ") : "_none checked_"}`,
  `- Ran: ${formatField(hygiene.ran)}`,
  `- Did not run: ${formatField(hygiene.didNotRun)}`,
  `- Reviewer should verify: ${formatField(hygiene.reviewerShouldVerify)}`,
  "",
  "## Semantic PR Hygiene",
  ...semanticSignals.map((line) => `- ${line}`),
  "",
  "## Reviewer Focus",
  ...(focus.length > 0
    ? focus.map((line) => `- ${line}`)
    : [`- This diff does not trip any extra preflight callouts beyond the standard ${validationLaneName} suite.`]),
].join("\n");

const existing = comments.find((comment) =>
  comment.user?.login === "github-actions[bot]" &&
  markers.some((candidate) => comment.body?.includes(candidate))
);

const summary = [
  "# Signalkeeper Preflight",
  `- Scope: ${repoScope}`,
  `- Files changed: ${files.length}`,
  `- Risk tags: ${changed.riskTags.length > 0 ? changed.riskTags.join(", ") : "docs-only"}`,
  "",
  "## Changed Surfaces",
  ...areaLines,
  "",
  "## Author Intent",
  `- Linked issue: ${formatField(hygiene.linkedIssue, "not stated")}`,
  `- Acceptance criteria: ${formatField(hygiene.acceptanceCriteria, "not stated")}`,
  `- Risk area: ${formatField(hygiene.riskArea, "not stated")}`,
  `- Reviewer focus from author: ${formatField(hygiene.reviewerFocus, "not stated")}`,
  `- Completed checks claimed by author: ${hygiene.checkedItems.length > 0 ? hygiene.checkedItems.slice(0, 5).join(", ") : "none checked"}`,
  "",
  "## Semantic PR Hygiene",
  ...semanticSignals.map((line) => `- ${line}`),
  "",
  "## Reviewer Focus",
  ...(focus.length > 0
    ? focus.map((line) => `- ${line}`)
    : ["- No extra preflight callouts beyond the standard validation suite."]),
  "",
  "## Validation Availability",
  `- Advisory checks visible: ${checks.advisoryVisible.length > 0 ? checks.advisoryVisible.join(", ") : "none detected yet"}`,
  `- Authoritative checks visible: ${checks.visibleValidation.length > 0 ? checks.visibleValidation.join(", ") : "none detected yet"}`,
  `- ${availability.message}`,
].join("\n");

writeSummary(summary);

try {
  if (existing) {
    await githubRequest(`/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: { body },
    });
  } else {
    await githubRequest(`/issues/${prNumber}/comments`, {
      method: "POST",
      body: { body },
    });
  }
} catch (error) {
  warn(
    `Signalkeeper Preflight could not publish its sticky PR comment: ${
      error?.message || String(error)
    }`
  );
  warn(
    "Signalkeeper Preflight is advisory; the run summary was still written and this comment publish failure will not fail the check."
  );
}
