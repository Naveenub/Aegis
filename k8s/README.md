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

2. **`aegis-server` runs 2 replicas.** Vector search uses RediSearch
   (`FT.SEARCH`) on the Redis Stack in `03-redis.yaml`, shared by all pods, and
   `vector-memory.js` refuses to start without it unless
   `AEGIS_ALLOW_HNSW_FALLBACK=true`. **Never set that flag on k8s:** the
   fallback HNSW index is pod-local, so extra replicas would silently miss
   memories written elsewhere. Rate-limit counters also fall back to per-pod
   memory if Redis is unreachable at pod start, so keep Redis healthy before
   scaling. Redis itself stays a single StatefulSet replica (a real SPOF —
   see "Not included").

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

4. **Isolated sandbox runner (`06a-sandbox.yaml`).** Tenant lint/test code
   runs on a dedicated `aegis-sandbox` Deployment, not beside the worker. Its
   dockerd needs `privileged: true`, which is only acceptable inside a
   microVM, so the pod sets `runtimeClassName` — you MUST point it at a
   Kata/Firecracker-style RuntimeClass that exists on your cluster (if the
   class is missing the pod stays Pending and runs fail closed). Do not
   remove it. The NetworkPolicy there only restricts access if your CNI
   enforces NetworkPolicy. Build `Dockerfile.sandbox`, push it, and set
   `AEGIS_SANDBOX_IMAGE` in `01-configmap.yaml`.

   The Docker API is **mutual TLS only** (port 2376), so isolation does not
   depend on NetworkPolicy alone. Generate certs and create both Secrets
   before `kubectl apply -k k8s/`:

   ```sh
   EXTRA_SANS="aegis-sandbox.aegis.svc,aegis-sandbox.aegis.svc.cluster.local" \
     scripts/provision-runner.sh certs aegis-sandbox ./runner-certs
   cd runner-certs
   kubectl -n aegis create secret generic aegis-sandbox-server-tls \
     --from-file=ca.pem --from-file=server-cert.pem --from-file=server-key.pem
   kubectl -n aegis create secret generic aegis-sandbox-client-tls \
     --from-file=ca.pem --from-file=cert.pem --from-file=key.pem
   ```

   Keep `ca-key.pem` offline; certs expire in 365 days.

5. **Secrets.** Copy `02-secret.example.yaml` → `02-secret.yaml`, fill in
   real values, uncomment it in `kustomization.yaml`. Never commit
   `02-secret.yaml`.

## Apply

```bash
kubectl apply -k k8s/
kubectl -n aegis get pods -w
```

## Not included

Redis is a single replica with no failover (use a managed Redis Stack or Sentinel/cluster for an availability SLA). No manifests for `.github/workflows/ci.yml`-triggered image builds, no
PodDisruptionBudget, no cert-manager Certificate for the Ingress, and no
NetworkPolicy beyond the one guarding the sandbox runner in `06a-sandbox.yaml`.
Add per your cluster's conventions.
