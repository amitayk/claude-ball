# Arena API + sandboxed match runner. Single image for the P1 single-box deploy.
FROM node:22-slim

WORKDIR /app

# Install deps (workspaces). Copy manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY templates ./templates
COPY apps ./apps
COPY tsconfig.json ./

RUN npm ci

ENV PORT=8787
# JSON store lives on a mounted volume so the ladder survives restarts.
ENV KR_DATA=/data/arena.json
ENV KR_PLACEMENT_SEEDS=3

EXPOSE 8787
CMD ["npm", "run", "api"]
