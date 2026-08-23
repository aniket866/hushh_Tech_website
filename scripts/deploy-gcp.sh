#!/usr/bin/env bash
# =============================================================================
# Deploy Hushh Tech Website to GCP Cloud Run
#
# Usage:
#   ./scripts/deploy-gcp.sh                    # Deploy with defaults
#   ./scripts/deploy-gcp.sh --project my-proj  # Override GCP project
#   ./scripts/deploy-gcp.sh --region asia-south1  # Override region
#   ./scripts/deploy-gcp.sh --local-build      # Build locally, skip Docker
#
# Prerequisites:
#   1. gcloud CLI installed & authenticated: gcloud auth login
#   2. Docker installed (for local Docker builds)
#   3. All env vars set in .env.local or exported
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
SERVICE_NAME="hushh-tech-website"
REGION="us-central1"
PROJECT_ID=""
LOCAL_BUILD=false
MEMORY="512Mi"
CPU="1"
MIN_INSTANCES="0"
MAX_INSTANCES="10"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)   PROJECT_ID="$2"; shift 2 ;;
    --region)    REGION="$2"; shift 2 ;;
    --service)   SERVICE_NAME="$2"; shift 2 ;;
    --local-build) LOCAL_BUILD=true; shift ;;
    --memory)    MEMORY="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--project PROJECT_ID] [--region REGION] [--service NAME] [--local-build] [--memory 512Mi]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Auto-detect project if not provided
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  if [ -z "$PROJECT_ID" ]; then
    echo "❌ No GCP project set. Use: gcloud config set project YOUR_PROJECT_ID"
    echo "   Or run: $0 --project YOUR_PROJECT_ID"
    exit 1
  fi
fi

echo "=============================================="
echo "🚀 Deploying Hushh Tech Website to GCP Cloud Run"
echo "=============================================="
echo "  Project:  $PROJECT_ID"
echo "  Service:  $SERVICE_NAME"
echo "  Region:   $REGION"
echo "  Memory:   $MEMORY"
echo "  CPU:      $CPU"
echo "=============================================="

# ---------------------------------------------------------------------------
# Load .env.local if it exists (for local deploys)
# ---------------------------------------------------------------------------
if [ -f ".env.local" ]; then
  echo "📋 Loading environment variables from .env.local"
  set -a
  source .env.local
  set +a
fi

# ---------------------------------------------------------------------------
# Step 1: Build the Vite frontend locally
# ---------------------------------------------------------------------------
echo ""
echo "📦 Step 1: Building frontend..."
npm run build 2>&1 || {
  echo "❌ Build failed. Fix errors and try again."
  exit 1
}
echo "✅ Frontend built successfully (dist/)"

# ---------------------------------------------------------------------------
# Step 2: Enable required GCP APIs (first-time only)
# ---------------------------------------------------------------------------
echo ""
echo "🔧 Step 2: Ensuring GCP APIs are enabled..."
gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  searchconsole.googleapis.com \
  --project="$PROJECT_ID" 2>/dev/null || true
echo "✅ APIs enabled"

# ---------------------------------------------------------------------------
# Step 3: Deploy to Cloud Run (source-based deploy — no Docker needed locally)
# ---------------------------------------------------------------------------
echo ""
echo "🚀 Step 3: Deploying to Cloud Run..."

# Collect server-side env vars to pass to Cloud Run
ENV_VARS="NODE_ENV=production"

# Add each server-side env var if set
[ -n "${OPENAI_API_KEY:-}" ] && ENV_VARS+=",OPENAI_API_KEY=${OPENAI_API_KEY}"
[ -n "${GEMINI_API_KEY:-}" ] && ENV_VARS+=",GEMINI_API_KEY=${GEMINI_API_KEY}"
[ -n "${GEMINI_API_KEY_2:-}" ] && ENV_VARS+=",GEMINI_API_KEY_2=${GEMINI_API_KEY_2}"
[ -n "${GEMINI_API_KEY_3:-}" ] && ENV_VARS+=",GEMINI_API_KEY_3=${GEMINI_API_KEY_3}"
[ -n "${GEMINI_API_KEY_4:-}" ] && ENV_VARS+=",GEMINI_API_KEY_4=${GEMINI_API_KEY_4}"
[ -z "${GMAIL_USER_SECRET_NAME:-}" ] && [ -n "${GMAIL_USER:-}" ] && ENV_VARS+=",GMAIL_USER=${GMAIL_USER}"
[ -z "${GMAIL_APP_PASSWORD_SECRET_NAME:-}" ] && [ -n "${GMAIL_APP_PASSWORD:-}" ] && ENV_VARS+=",GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD}"
[ -n "${GOOGLE_APPS_SCRIPT_URL:-}" ] && ENV_VARS+=",GOOGLE_APPS_SCRIPT_URL=${GOOGLE_APPS_SCRIPT_URL}"
[ -n "${GOOGLE_WALLET_ISSUER_ID:-}" ] && ENV_VARS+=",GOOGLE_WALLET_ISSUER_ID=${GOOGLE_WALLET_ISSUER_ID}"
[ -n "${GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:-}" ] && ENV_VARS+=",GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=${GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL}"
[ -n "${GOOGLE_WALLET_PRIVATE_KEY:-}" ] && ENV_VARS+=",GOOGLE_WALLET_PRIVATE_KEY=${GOOGLE_WALLET_PRIVATE_KEY}"
[ -n "${GOOGLE_WALLET_CLASS_SUFFIX:-}" ] && ENV_VARS+=",GOOGLE_WALLET_CLASS_SUFFIX=${GOOGLE_WALLET_CLASS_SUFFIX}"
[ -n "${GOOGLE_WALLET_ALLOWED_ORIGINS:-}" ] && ENV_VARS+=",GOOGLE_WALLET_ALLOWED_ORIGINS=${GOOGLE_WALLET_ALLOWED_ORIGINS}"
[ -n "${CLOUD_SQL_INSTANCE_CONNECTION_NAME:-}" ] && ENV_VARS+=",CLOUD_SQL_INSTANCE_CONNECTION_NAME=${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
[ -z "${GCP_SERVER_ACTOR_UID_SECRET_NAME:-}" ] && [ -n "${GCP_SERVER_ACTOR_UID:-}" ] && ENV_VARS+=",GCP_SERVER_ACTOR_UID=${GCP_SERVER_ACTOR_UID}"
[ -n "${LEGACY_CLOUD_SQL_INSTANCE_CONNECTION_NAME:-}" ] && ENV_VARS+=",LEGACY_CLOUD_SQL_INSTANCE_CONNECTION_NAME=${LEGACY_CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
[ -n "${LEGACY_GCP_SERVER_ACTOR_UID:-}" ] && ENV_VARS+=",LEGACY_GCP_SERVER_ACTOR_UID=${LEGACY_GCP_SERVER_ACTOR_UID}"
[ -n "${METRICS_REPORT_RECIPIENTS:-}" ] && ENV_VARS+=",METRICS_REPORT_RECIPIENTS=${METRICS_REPORT_RECIPIENTS}"
[ -n "${METRICS_REPORT_TIMEZONE:-}" ] && ENV_VARS+=",METRICS_REPORT_TIMEZONE=${METRICS_REPORT_TIMEZONE}"
[ -n "${METRICS_REPORT_SCHEDULE:-}" ] && ENV_VARS+=",METRICS_REPORT_SCHEDULE=${METRICS_REPORT_SCHEDULE}"
[ -n "${METRICS_REPORT_FROM_EMAIL:-}" ] && ENV_VARS+=",METRICS_REPORT_FROM_EMAIL=${METRICS_REPORT_FROM_EMAIL}"
[ -n "${METRICS_REPORT_SHARED_SECRET:-}" ] && ENV_VARS+=",METRICS_REPORT_SHARED_SECRET=${METRICS_REPORT_SHARED_SECRET}"
[ -n "${GOOGLE_API_KEY:-}" ] && ENV_VARS+=",GOOGLE_API_KEY=${GOOGLE_API_KEY}"
[ -z "${ANALYTICS_HASH_SALT_SECRET_NAME:-}" ] && [ -n "${ANALYTICS_HASH_SALT:-}" ] && ENV_VARS+=",ANALYTICS_HASH_SALT=${ANALYTICS_HASH_SALT}"
[ -n "${GCP_MONITORING_PROJECT_ID:-}" ] && ENV_VARS+=",GCP_MONITORING_PROJECT_ID=${GCP_MONITORING_PROJECT_ID}"
[ -n "${GCP_CLOUD_RUN_REGION:-}" ] && ENV_VARS+=",GCP_CLOUD_RUN_REGION=${GCP_CLOUD_RUN_REGION}"
[ -n "${GCP_CLOUD_RUN_SERVICES:-}" ] && ENV_VARS+=",GCP_CLOUD_RUN_SERVICES=${GCP_CLOUD_RUN_SERVICES}"
[ -n "${SEARCH_CONSOLE_SITE_URL:-}" ] && ENV_VARS+=",SEARCH_CONSOLE_SITE_URL=${SEARCH_CONSOLE_SITE_URL}"
[ -n "${SEARCH_CONSOLE_TYPE:-}" ] && ENV_VARS+=",SEARCH_CONSOLE_TYPE=${SEARCH_CONSOLE_TYPE}"
[ -n "${SEARCH_CONSOLE_DATA_STATE:-}" ] && ENV_VARS+=",SEARCH_CONSOLE_DATA_STATE=${SEARCH_CONSOLE_DATA_STATE}"
[ -n "${SEARCH_CONSOLE_ROW_LIMIT:-}" ] && ENV_VARS+=",SEARCH_CONSOLE_ROW_LIMIT=${SEARCH_CONSOLE_ROW_LIMIT}"
SECRET_BINDINGS=""
[ -n "${GCP_SERVER_ACTOR_UID_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",GCP_SERVER_ACTOR_UID=${GCP_SERVER_ACTOR_UID_SECRET_NAME}:latest"
[ -n "${GMAIL_USER_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",GMAIL_USER=${GMAIL_USER_SECRET_NAME}:latest"
[ -n "${GMAIL_APP_PASSWORD_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD_SECRET_NAME}:latest"
[ -n "${LOOKER_STUDIO_EMBED_URL_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",LOOKER_STUDIO_EMBED_URL=${LOOKER_STUDIO_EMBED_URL_SECRET_NAME}:latest"
[ -n "${GA4_PROPERTY_ID_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",GA4_PROPERTY_ID=${GA4_PROPERTY_ID_SECRET_NAME}:latest"
[ -n "${GA4_ALLOWED_HOSTNAMES_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",GA4_ALLOWED_HOSTNAMES=${GA4_ALLOWED_HOSTNAMES_SECRET_NAME}:latest"
[ -n "${LEGACY_GCP_SERVER_ACTOR_UID_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",LEGACY_GCP_SERVER_ACTOR_UID=${LEGACY_GCP_SERVER_ACTOR_UID_SECRET_NAME}:latest"
[ -n "${METRICS_REPORT_SHARED_SECRET_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",METRICS_REPORT_SHARED_SECRET=${METRICS_REPORT_SHARED_SECRET_SECRET_NAME}:latest"
[ -n "${ANALYTICS_HASH_SALT_SECRET_NAME:-}" ] && SECRET_BINDINGS+=",ANALYTICS_HASH_SALT=${ANALYTICS_HASH_SALT_SECRET_NAME}:latest"

DEPLOY_ARGS=(
  --source .
  --region "$REGION"
  --project "$PROJECT_ID"
  --platform managed
  --allow-unauthenticated
  --memory "$MEMORY"
  --cpu "$CPU"
  --min-instances "$MIN_INSTANCES"
  --max-instances "$MAX_INSTANCES"
  --concurrency 250
  --timeout 60s
  --set-env-vars "$ENV_VARS"
  --quiet
)

if [ -n "$SECRET_BINDINGS" ]; then
  DEPLOY_ARGS+=(--set-secrets "${SECRET_BINDINGS#,}")
fi

# Deploy using Cloud Run source deploy (builds in Cloud Build automatically)
# Note: .gcloudignore ensures dist/ is included in the upload
gcloud run deploy "$SERVICE_NAME" "${DEPLOY_ARGS[@]}"

# ---------------------------------------------------------------------------
# Step 4: Get the service URL
# ---------------------------------------------------------------------------
echo ""
echo "=============================================="
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format='value(status.url)' 2>/dev/null)

echo "✅ Deployment complete!"
echo ""
echo "🌐 Service URL: $SERVICE_URL"
echo ""
echo "=============================================="
echo ""
echo "📌 Next steps:"
echo "   1. Test: curl $SERVICE_URL"
echo "   2. Map custom domain:"
echo "      gcloud run domain-mappings create \\"
echo "        --service $SERVICE_NAME \\"
echo "        --domain your-domain.com \\"
echo "        --region $REGION"
echo ""
echo "   3. Set up CI/CD (optional):"
echo "      gcloud builds triggers create github \\"
echo "        --repo-name=hushh_Tech_website \\"
echo "        --repo-owner=hushh-labs \\"
echo "        --branch-pattern='^main\$' \\"
echo "        --build-config=cloudbuild.yaml"
echo "=============================================="
