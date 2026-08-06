# AEGIS on Kubernetes

## Before you apply

1. **Redis-host bug — fix or this breaks at >1 replica.**
   `concurrency.js`, `lock.js`, `git.js`, `key-store.js`, `idempotency.js`,
   `tenant-registry.js`, `workflow-store.js`, `vector-memory.js`, and
   `template-store.js` construct `new IORedis()` with no arguments, which
   defaults to `127.0.0.1:6379` and ignores `REDIS_URL`. These manifests
   point every pod at a `redis` Service — that only works once those 9 files
   read `process.env.REDIS_URL` like `queue.js`/`job-store.js`/`metrics.js`
   already do. Distributed locking and per-workflow git locks are silently
   broken across pods until this is fixed.

2. **Build and push the image.**
   ```bash
   docker build -t your-registry/aegis:latest .
   docker push your-registry/aegis:latest
   ```
   Then replace `your-registry/aegis:latest` in `05-server.yaml`,
   `06-worker.yaml`, `07-dlq-worker.yaml`.

3. **RWX storage for `aegis-repo`.** `04-repo-pvc.yaml` requests
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
