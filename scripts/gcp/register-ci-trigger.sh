#!/usr/bin/env bash
# Plan or apply the default Cloud Build pull-request CI trigger.
#
# The default is read-only. --apply is an explicit infrastructure mutation that
# reconciles only the named trigger; it never grants IAM roles or creates keys.

set -euo pipefail

PROJECT_ID="${HUSHH_TECH_CI_PROJECT:-hushh-tech-uat}"
REGION="${HUSHH_TECH_CI_REGION:-us-central1}"
REMOTE_URI="${HUSHH_TECH_REPOSITORY_REMOTE:-https://github.com/hushh-labs/hushh_Tech_website.git}"
TRIGGER_NAME="${HUSHH_TECH_CI_TRIGGER_NAME:-hushh-tech-website-ci}"
# The project requires a user-managed trigger identity. Use the existing
# least-privilege build identity explicitly so trigger creation is deterministic
# without granting a deployer or secret-accessor identity to pull-request builds.
SERVICE_ACCOUNT="${HUSHH_TECH_CI_SERVICE_ACCOUNT:-projects/${PROJECT_ID}/serviceAccounts/cloud-run-build@${PROJECT_ID}.iam.gserviceaccount.com}"
APPLY=0

usage() {
  cat <<'USAGE'
Usage: scripts/gcp/register-ci-trigger.sh [--apply]

Default: resolve the 2nd-generation repository and print the CI trigger plan.
--apply: replace or create only the named pull-request trigger.

The command never grants IAM roles or creates credentials.
USAGE
}

while (($#)); do
  case "$1" in
    --apply) APPLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "project: ${PROJECT_ID}"
echo "region: ${REGION}"
echo "remote: ${REMOTE_URI}"
echo "trigger: ${TRIGGER_NAME}"
echo "service account: ${SERVICE_ACCOUNT}"

repo_resource=""
while IFS= read -r connection; do
  [[ -z "${connection}" ]] && continue
  candidate="$(gcloud builds repositories list \
    --project="${PROJECT_ID}" --region="${REGION}" --connection="${connection##*/}" \
    --filter="remoteUri=${REMOTE_URI}" --format='get(name)' 2>/dev/null | head -1 || true)"
  if [[ -n "${candidate}" ]]; then
    repo_resource="${candidate}"
    break
  fi
done < <(gcloud builds connections list --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(name)' 2>/dev/null || true)

if [[ -z "${repo_resource}" ]]; then
  cat >&2 <<EOF2
No 2nd-generation Cloud Build repository link was found for ${REMOTE_URI}.
Create/authorize the GitHub connection and link this repository in:
https://console.cloud.google.com/cloud-build/repositories/2nd-gen?project=${PROJECT_ID}
EOF2
  exit 1
fi
echo "repository link: ${repo_resource}"

existing="$(gcloud builds triggers list --project="${PROJECT_ID}" --region="${REGION}" \
  --filter="name=${TRIGGER_NAME}" --format=json 2>/dev/null || echo '[]')"
existing_count="$(jq 'length' <<<"${existing}")"
if ((existing_count > 1)); then
  echo "more than one trigger matches ${TRIGGER_NAME}; refusing to choose" >&2
  exit 1
fi

expected="$(jq -cn \
  --arg repo "${repo_resource}" \
  --arg service_account "${SERVICE_ACCOUNT}" \
  '{repository:$repo,pull_request_pattern:"^main$",comment_control:"COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY",filename:"cloudbuild.ci.yaml",include_build_logs:"INCLUDE_BUILD_LOGS_WITH_STATUS",service_account:$service_account}')"

if ((existing_count == 1)); then
  current="$(jq -c '.[0] | {
    repository:(.repositoryEventConfig.repository // ""),
    pull_request_pattern:(.repositoryEventConfig.pullRequest.branch // ""),
    comment_control:(.repositoryEventConfig.pullRequest.commentControl // ""),
    filename:(.filename // ""),
    include_build_logs:(.includeBuildLogs // "INCLUDE_BUILD_LOGS_UNSPECIFIED"),
    service_account:(.serviceAccount // "")
  }' <<<"${existing}")"
  echo "existing trigger contract: ${current}"
  if [[ "${current}" == "${expected}" ]]; then
    echo "plan: trigger already matches; no change"
    exit 0
  fi
  echo "plan: replace the mismatched trigger only"
else
  echo "plan: create the pull-request trigger"
fi

echo "  repository=${repo_resource}"
echo "  pull-request-base=^main$"
echo "  comment-control=COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY"
echo "  build-config=cloudbuild.ci.yaml"
echo "  include-build-logs-with-status=true"
echo "  service-account=${SERVICE_ACCOUNT}"

if ((APPLY == 0)); then
  echo "plan only: rerun with --apply to reconcile this trigger"
  exit 0
fi

if ((existing_count == 1)); then
  trigger_id="$(jq -r '.[0].id' <<<"${existing}")"
  gcloud builds triggers delete "${trigger_id}" --project="${PROJECT_ID}" --region="${REGION}" --quiet
fi

gcloud builds triggers create github \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --name="${TRIGGER_NAME}" \
  --description="Default pull-request CI gates in Cloud Build; GitHub Actions remains manual backup" \
  --repository="${repo_resource}" \
  --pull-request-pattern='^main$' \
  --comment-control=COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY \
  --include-logs-with-status \
  --no-require-approval \
  --service-account="${SERVICE_ACCOUNT}" \
  --build-config=cloudbuild.ci.yaml

echo "reconciled: ${TRIGGER_NAME}"
