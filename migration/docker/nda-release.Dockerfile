# Build with repository root as context, using the reviewed, locked existing
# attestor dependency set. This is NOT the web Dockerfile or historical bundle.
FROM --platform=linux/amd64 node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3
ENV NODE_ENV=production NODE_OPTIONS=--disable-proto=throw MODE=preflight
WORKDIR /app
COPY cloud-run/hushh-tech-cloudsql-attestor/package.json cloud-run/hushh-tech-cloudsql-attestor/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY scripts/gcp/migration/nda-release.mjs scripts/gcp/migration/nda-release.mjs
COPY migration/sql/003_firebase_native_mapping_basis.sql migration/sql/004_firebase_native_provisioning.sql migration/sql/
USER 1000:1000
ENTRYPOINT ["node", "scripts/gcp/migration/nda-release.mjs"]
