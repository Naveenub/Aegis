# AEGIS on Kubernetes

## Before you apply

1. **Redis-host bug — fixed.** `concurrency.js`, `lock.js`, `key-store.js`,
   `idempotency.js`, `tenant-registry.js`, `workflow-store.js`,
   `template-store.js`, and `vector-memory.js` used to construct
   `new IORedis()` with no arguments, defaulting to `127.0.0.1:6379` and
   ignoring `REDIS_URL`. They now read `process.env.REDIS_URL` like
   `queue.js`/`job-store.js`/`metrics.js` already did. `git.js` does not
   use Redis and was never affected — it was mislisted here previously.
   Just make sure `REDIS_URL` is actually set (`01-configmap.yaml` or
   `02-secret.yaml`) before applying.

2. **`aegis-server` is pinned to 1 replica.** When Redis Stack isn't
   present, `vector-memory.js` falls back to a local HNSW index
   (hnswlib-node) held in-process and persisted to the container's
   ephemeral disk — not Redis. Fixing item 1 makes the BM25/weights/age
   metadata shared across pods, but the HNSW ANN index itself is still
   pod-local, so a second replica would silently miss memories written to
   the other pod. Scale past 1 only once Redis Stack (`FT.*` commands) is
   guaranteed available, so `searchMemory` uses the shared `FT.SEARCH`
   path instead of HNSW.

3. **Build and push the image.**
   ```bash
   docker build -t your-registry/aegis:latest .
   docker push your-registry/aegis:latest
   ```
   Then replace `your-registry/aegis:latest` in `05-server.yaml`,
   `06-worker.yaml`, `07-dlq-worker.yaml`.

4. **RWX storage for `aegis-repo`.** `04-repo-pvc.yaml` requests
   `ReadWriteMany` — the default StorageClass on most managed clusters
   (EBS, PD, Azure Disk) is `ReadWriteOnce` and will not satisfy this. Set
   `storageClassName` to an RWX-capable class (EFS, Filestore, Longhorn,
   NFS) first.

4. **`dind` sidecar runs `privileged: true`.** Vanilla Kubernetes has no
   equivalent of compose's `/dev/fuse` + `/dev/net/tun` device passthrough
   for an unprivileged rootless daemon — see the comment in
   `06-worker.yaml`. Harden with a runtime like sysbox or kata before
   running untrusted tenant code through this in production.

5. **Secrets.** Copy `02-secret.example.yaml` → `02-secret.yaml`, fill in
   real values, uncomment it in `kustomization.yaml`. Never commit
   `02-secret.yaml`.

## Apply

```bash
kubectl apply -k k8s/
kubectl -n aegis get pods -w
```

## Not included

No manifests for `.github/workflows/ci.yml`-triggered image builds, no
NetworkPolicy, no PodDisruptionBudget, no cert-manager Certificate for the
Ingress. Add per your cluster's conventions.
