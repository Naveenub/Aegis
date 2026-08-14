---
id: deployment
title: Deployment
sidebar_position: 6
---

# Deployment

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d --build
```

This starts `redis`, `server` (port 3000), `worker`, `dlq-worker`, and a rootless `dind` sidecar from a single `node:20-alpine` image (`Dockerfile`). Two things worth knowing:

- **`worker` talks to a rootless Docker-in-Docker sidecar (`dind`), not the host socket.** `sandbox.js` shells out to `docker run` for every lint/test execution; pointing `DOCKER_HOST` at the isolated rootless daemon instead of mounting `/var/run/docker.sock` means a sandbox compromise is capped at that sidecar's unprivileged UID rather than the host. For a genuinely multi-tenant/shared deployment, the next step up is a dedicated remote Docker host instead of a same-machine sidecar.
- **`server` and `worker` share a `repo` volume** so `AEGIS_REPO_ROOT`/`AEGIS_WORKTREES` resolve to the same git checkout across both processes.

Kubernetes manifests are provided under `k8s/` (namespace, configmap, Redis, PVC, server/worker/dlq-worker deployments, HPA, ingress, kustomization) — see `k8s/README.md` in the repo for apply instructions.
