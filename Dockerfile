FROM node:22-slim AS base
WORKDIR /app

# Install pnpm directly — more reliable than Corepack in CI/Docker build environments
RUN npm install -g pnpm@11.5.2

# Install dependencies.
# --ignore-scripts: skip postinstall scripts (avoids ERR_PNPM_IGNORED_BUILDS for esbuild).
# pnpm rebuild esbuild: compile the esbuild native binary for the target platform (Linux).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm rebuild esbuild

# Application source
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Persistent data directory — mount a named volume here in production.
RUN mkdir -p /app/data

RUN chmod +x /app/scripts/entrypoint.sh

ENV PORT=8420
EXPOSE 8420

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
