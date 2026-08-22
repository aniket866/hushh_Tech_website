# check=skip=FromPlatformFlagConstDisallowed
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV NODE_ENV=production
WORKDIR /app

COPY package-server.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY api ./api
COPY migration/smoke/edge-function-gateway-uat.mjs ./migration/smoke/edge-function-gateway-uat.mjs

USER node
CMD ["node", "migration/smoke/edge-function-gateway-uat.mjs"]
