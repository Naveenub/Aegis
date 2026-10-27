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

> **Not for paid multi-tenant use.** This compose stack is for local dev and single-tenant self-hosting: the `dind` sidecar shares a machine and a plaintext internal network with the app, and `AEGIS_SANDBOX_MODE=local` runs generated code on the host. Self-serve signup is refused here by design. For paid multi-tenant use, run tenant code on an isolated runner — a remote Docker host over mutual TLS on gVisor/Firecracker/Kata (Render, VM) or the k8s `aegis-sandbox` microVM runtime class — and set `DOCKER_HOST` + `DOCKER_TLS_VERIFY=1`. Signup only enables when such a runner is configured (or `AEGIS_ALLOW_UNSANDBOXED_SIGNUP=true` for demos).

**Render / other hosts without nested Docker:** set `DOCKER_HOST` to a disposable remote Docker host (mutual TLS; a dedicated VM, or a gVisor/Firecracker/Kata host) and `AEGIS_SANDBOX_IMAGE` to an image built from `Dockerfile.sandbox`. Tenant code never runs on the web service. If `DOCKER_HOST` is unset or unreachable, lint/test steps are blocked, and `AEGIS_SANDBOX_MODE=local`/`CI=true` do not override that.

Kubernetes manifests are provided under `k8s/` (namespace, configmap, Redis, PVC, server/worker/dlq-worker deployments, HPA, ingress, kustomization) — see `k8s/README.md` in the repo for apply instructions.
