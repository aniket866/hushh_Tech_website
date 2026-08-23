# check=skip=FromPlatformFlagConstDisallowed
# Cloud Run release images are intentionally locked to the reviewed architecture.
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY registry ./registry
COPY src ./src
COPY smoke ./smoke

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
