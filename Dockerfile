FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

# Install dependencies
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# Application source
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Persistent data directory (schema dump + entity registry).
# Mount a named volume here so data survives container restarts / upgrades.
RUN mkdir -p /app/data

RUN chmod +x /app/scripts/entrypoint.sh

ENV PORT=8420
EXPOSE 8420

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
