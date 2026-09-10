#!/usr/bin/env bash
# Plan or apply the 2nd-gen Cloud Build tag trigger for the UAT-only direct lane.
#
# The default is read-only plan mode. A human with Cloud Build and GitHub
# connection authority must run --apply after reviewing the resolved repository
# link and service account. This script deliberately does not grant IAM roles or
# create credentials. Production has no trigger here until it has an immutable
# UAT verification receipt and rollback contract of its own.

set -euo pipefail

PROJECT_ID="${HUSHH_TECH_UAT_PROJECT:-hushh-tech-uat}"
REGION="${HUSHH_TECH_CLOUDBUILD_REGION:-us-central1}"
REMOTE_URI="${HUSHH_TECH_REPOSITORY_REMOTE:-https://github.com/hushh-labs/hushh_Tech_website.git}"
TRIGGER_NAME="${HUSHH_TECH_UAT_TRIGGER_NAME:-hushh-tech-website-uat-tag-deploy}"
DEPLOYER_SA="${HUSHH_TECH_UAT_DEPLOYER_SA:-hushh-tech-deployer@${PROJECT_ID}.iam.gserviceaccount.com}"
APPLY=0

usage() {
  cat <<'EOF'
Usage: scripts/gcp/register-direct-uat-trigger.sh [--apply]

Default: resolve and print the Cloud Build repository link and trigger plan.
--apply: replace only the named trigger with the reviewed UAT tag trigger.

The Cloud Build GitHub connection/repository link and deployer IAM roles are
human-managed prerequisites. This command never grants roles or creates keys.
EOF
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
echo "deployer service account: ${DEPLOYER_SA}"

repo_resource=""
while IFS= read -r connection; do
  [[ -z "$connection" ]] && continue
  candidate="$(gcloud builds repositories list \
    --project="$PROJECT_ID" --region="$REGION" --connection="${connection##*/}" \
    --filter="remoteUri=${REMOTE_URI}" --format='get(name)' 2>/dev/null | head -1 || true)"
  if [[ -n "$candidate" ]]; then
    repo_resource="$candidate"
    break
  fi
done < <(gcloud builds connections list --project="$PROJECT_ID" --region="$REGION" \
  --format='value(name)' 2>/dev/null || true)

if [[ -z "$repo_resource" ]]; then
  cat >&2 <<EOF
No 2nd-gen Cloud Build repository link was found for ${REMOTE_URI}.
Create/authorize the GitHub connection and link this repository in:
https://console.cloud.google.com/cloud-build/repositories/2nd-gen?project=${PROJECT_ID}
EOF
  exit 1
fi
echo "repository link: ${repo_resource}"

if ! gcloud iam service-accounts describe "$DEPLOYER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "deployer service account does not exist: ${DEPLOYER_SA}" >&2
  exit 1
fi

existing="$(gcloud builds triggers list --project="$PROJECT_ID" --region="$REGION" \
  --filter="name=${TRIGGER_NAME}" --format=json 2>/dev/null || echo '[]')"
existing_count="$(jq 'length' <<<"$existing")"
if ((existing_count > 1)); then
  echo "more than one trigger matches ${TRIGGER_NAME}; refusing to choose" >&2
  exit 1
fi

expected="$(jq -n \
  --arg repo "$repo_resource" \
  --arg sa "projects/${PROJECT_ID}/serviceAccounts/${DEPLOYER_SA}" \
  '{repository:$repo, tag_pattern:"uat-.*", filename:"deploy/uat-tag-trigger.cloudbuild.yaml", service_account:$sa}')"

if ((existing_count == 1)); then
  current="$(jq '.[0] | {
    repository:(.repositoryEventConfig.repository // ""),
    tag_pattern:(.repositoryEventConfig.push.tag // ""),
    filename:(.filename // ""),
    service_account:(.serviceAccount // "")
  }' <<<"$existing")"
  echo "existing trigger contract: ${current}"
  if [[ "$current" == "$expected" ]]; then
    echo "plan: trigger already matches; no change"
    exit 0
  fi
  echo "plan: replace the mismatched trigger only"
else
  echo "plan: create the UAT tag trigger"
fi
echo "  repository=${repo_resource}"
echo "  tag-pattern=uat-.*"
echo "  build-config=deploy/uat-tag-trigger.cloudbuild.yaml"
echo "  service-account=projects/${PROJECT_ID}/serviceAccounts/${DEPLOYER_SA}"

if ((APPLY == 0)); then
  echo "plan only: rerun with --apply to reconcile this trigger"
  exit 0
fi

if ((existing_count == 1)); then
  trigger_id="$(jq -r '.[0].id' <<<"$existing")"
  gcloud builds triggers delete "$trigger_id" --project="$PROJECT_ID" --region="$REGION" --quiet
fi

gcloud builds triggers create github \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --name="$TRIGGER_NAME" \
  --description="UAT-only direct Cloud Run deploy for explicit uat-* tags" \
  --repository="$repo_resource" \
  --tag-pattern='uat-.*' \
  --build-config=deploy/uat-tag-trigger.cloudbuild.yaml \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${DEPLOYER_SA}"

echo "reconciled: ${TRIGGER_NAME}"
