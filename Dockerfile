# =============================================================================
# Runtime-only Dockerfile for GCP Cloud Run
# dist/ is pre-built by CI/CD pipeline — no Vite build happens here
# =============================================================================

FROM node:20-alpine

WORKDIR /app

# Install server-side dependencies only
COPY package-server.json package.json
RUN npm install --omit=dev --no-audit --no-fund

# Copy pre-built Vite output
COPY dist/ dist/

# A runtime-only source deploy depends on dist/ already containing Vite's
# build-time auth configuration. Fail the container build before it can ship a
# login page whose OAuth client is undefined.
RUN node --input-type=module -e "\
  import fs from 'node:fs';\
  import path from 'node:path';\
  const assetsDir = path.join(process.cwd(), 'dist', 'assets');\
  const jsFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith('.js'));\
  const hasAuthConfig = jsFiles.some((file) => /identitytoolkit\\.googleapis\\.com/.test(fs.readFileSync(path.join(assetsDir, file), 'utf8')));\
  if (!hasAuthConfig) {\
    console.error('Prebuilt dist/ is missing compiled Firebase auth config. Rebuild with VITE_FIREBASE_AUTH_DOMAIN and VITE_FIREBASE_API_KEY from GCP Secret Manager before deploying.');\
    process.exit(1);\
  }\
"

# Copy server and API routes
COPY server.js ./
COPY api/ api/
COPY scripts/ci/check-no-hybrid-runtime.mjs scripts/ci/no-hybrid-runtime-policy.json scripts/ci/

# The committed public deck bodies (~3 MB), so api/community/content-service.js can serve a deck
# from disk when the content bucket is unreachable instead of rendering "the reading view could not
# be loaded". Dockerfile.gcp already carries these; this image is what deploy-prod.yml builds, and
# without them production had no fallback at all.
#
# Only the two public directories. `cards-gated/` and `text-gated/` are gitignored and must never
# reach an image — a gated deck's text is served from its GCS prefix behind the NDA check.
COPY content/decks/cards/ content/decks/cards/
COPY content/decks/text/ content/decks/text/

# Re-scan exactly what the runtime image can serve. This is intentionally
# independent from GitHub so direct Cloud Build and local image builds fail closed.
RUN node scripts/ci/check-no-hybrid-runtime.mjs --artifact-only --require-dist

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
