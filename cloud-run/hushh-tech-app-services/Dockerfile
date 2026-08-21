FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY registry ./registry
COPY src ./src

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
