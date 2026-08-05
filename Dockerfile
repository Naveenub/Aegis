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

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

# git is a hard dependency: git.js shells out to it for worktree/branch/commit
# management on every workflow step.
RUN apk add --no-cache git

COPY --from=deps /app/node_modules ./node_modules
COPY . .

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
