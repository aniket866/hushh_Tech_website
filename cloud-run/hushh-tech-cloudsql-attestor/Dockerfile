FROM --platform=linux/amd64 node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

COPY --chown=node:node Dockerfile .dockerignore ./
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node contracts ./contracts
COPY --chown=node:node sql ./sql
COPY --chown=node:node src ./src

USER 1000:1000

ENTRYPOINT ["node", "src/supervisor.js"]
