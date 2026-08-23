FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /app
COPY package.json index.mjs ./
USER 65532:65532
CMD ["node", "index.mjs"]
