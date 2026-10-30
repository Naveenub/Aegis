# syntax=docker/dockerfile:1

# AEGIS runs three processes from this same image (see docker-compose.yml):
#   node server.js               — API
#   node workers/agent-worker.js — workflow execution
#   node workers/dlq-worker.js   — retry/escalation

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── dashboard (React SPA → dashboard/dist, served by server.js at /app) ────────
FROM node:20-alpine AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

# git is a hard dependency: git.js shells out to it for worktree/branch/commit
# management on every workflow step.
# docker-cli: sandbox.js shells out to `docker run` against DOCKER_HOST.
RUN apk add --no-cache git docker-cli

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=dashboard /dashboard/dist ./dashboard/dist

# Non-root: agent-generated patches are already sandboxed via Docker in
# sandbox.js; the host process itself still shouldn't run as root.
RUN addgroup -S aegis && adduser -S aegis -G aegis \
    && chown -R aegis:aegis /app
USER aegis

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Overridden per-service by docker-compose.yml (server / worker / dlq-worker).
CMD ["node", "server.js"]
