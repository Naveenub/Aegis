#!/usr/bin/env bash
# scripts/sandbox-setup.sh — one-command helpers for the isolated sandbox runner.
#
#   runner <dns-or-ip> [--certs-only]   RUN ON THE RUNNER VM (root). Creates mTLS certs and
#                                       exposes dockerd on :2376. Client files for Render land
#                                       in $CERT_DIR/client (ca.pem cert.pem key.pem).
#   image  <tag> [--push|--compose]     Build Dockerfile.sandbox. --push also pushes to the
#                                       registry in <tag>; --compose builds inside compose's
#                                       dind daemon (so the worker can use a local tag).
#   runtimeclass [name]                 Set runtimeClassName in k8s/06a-sandbox.yaml. Without a
#                                       name, picks the first kata/firecracker class found.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cmd_runner() {
  local host="${1:?usage: runner <dns-or-ip> [--certs-only]}" only="${2:-}"
  local dir="${CERT_DIR:-/etc/aegis-sandbox/certs}" san
  command -v openssl >/dev/null || die "openssl is required"
  [[ "$host" =~ ^[0-9.]+$ ]] && san="IP:$host" || san="DNS:$host"

  umask 077
  mkdir -p "$dir/client"; cd "$dir"
  [[ -f ca.pem ]] || {
    openssl genrsa -out ca-key.pem 4096 2>/dev/null
    openssl req -new -x509 -days 365 -key ca-key.pem -sha256 -subj "/CN=aegis-ca" -out ca.pem
  }
  openssl genrsa -out server-key.pem 4096 2>/dev/null
  openssl req -new -key server-key.pem -subj "/CN=$host" -out server.csr
  echo "subjectAltName = $san" > server-ext.cnf
  openssl x509 -req -days 365 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem \
    -CAcreateserial -out server-cert.pem -extfile server-ext.cnf 2>/dev/null

  openssl genrsa -out client/key.pem 4096 2>/dev/null
  openssl req -new -key client/key.pem -subj "/CN=aegis-client" -out client.csr
  echo "extendedKeyUsage = clientAuth" > client-ext.cnf
  openssl x509 -req -days 365 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem \
    -CAcreateserial -out client/cert.pem -extfile client-ext.cnf 2>/dev/null
  cp ca.pem client/ca.pem
  chmod 600 ./*key.pem client/key.pem; chmod 644 client/ca.pem client/cert.pem
  rm -f server.csr client.csr server-ext.cnf client-ext.cnf

  echo "Certs written to $dir (client files in $dir/client)."
  [[ "$only" == "--certs-only" ]] && return 0

  [[ $EUID -eq 0 ]] || die "run as root to configure dockerd"
  command -v systemctl >/dev/null || die "systemd required; start dockerd manually with --tlsverify (see output above)"
  if [[ -f /etc/docker/daemon.json ]] && grep -q '"hosts"' /etc/docker/daemon.json; then
    die "/etc/docker/daemon.json sets \"hosts\", which conflicts with -H flags; remove it first"
  fi
  mkdir -p /etc/systemd/system/docker.service.d
  cat > /etc/systemd/system/docker.service.d/aegis-sandbox.conf <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2376 --tlsverify --tlscacert=$dir/ca.pem --tlscert=$dir/server-cert.pem --tlskey=$dir/server-key.pem
UNIT
  systemctl daemon-reload && systemctl restart docker
  cat <<MSG

Next:
  1. Firewall: allow tcp/2376 ONLY from your Render service's outbound IPs.
  2. Render: upload $dir/client/{ca,cert,key}.pem as Secret Files; set
     DOCKER_HOST=tcp://$host:2376 and AEGIS_SANDBOX_IMAGE.
  3. Pull the sandbox image on this host (or docker login to your registry).
  4. Certs expire in 365 days; re-run this command to rotate.
MSG
}

cmd_image() {
  local tag="${1:?usage: image <tag> [--push|--compose]}" mode="${2:-}"
  cd "$ROOT"
  case "$mode" in
    --compose)
      tar -cf - Dockerfile.sandbox package.json package-lock.json \
        | docker compose exec -T dind docker build -f Dockerfile.sandbox -t "$tag" - ;;
    ""|--push)
      docker build -f Dockerfile.sandbox -t "$tag" .
      [[ "$mode" == "--push" ]] && docker push "$tag" ;;
    *) die "unknown option: $mode" ;;
  esac
}

cmd_runtimeclass() {
  local rc="${1:-}" f="$ROOT/k8s/06a-sandbox.yaml"
  command -v kubectl >/dev/null || die "kubectl is required"
  if [[ -z "$rc" ]]; then
    rc="$(kubectl get runtimeclass -o name | sed 's|.*/||' | grep -iE 'kata|firecracker|(^|-)fc($|-)' | head -n1 || true)"
  fi
  [[ -n "$rc" ]] || die "no kata/firecracker RuntimeClass found; install one (e.g. kata-deploy) or pass a name"
  kubectl get runtimeclass "$rc" >/dev/null || die "RuntimeClass '$rc' does not exist"
  sed -i.bak -E "s|^( *runtimeClassName: )[^ ]+.*|\1$rc # set by sandbox-setup.sh|" "$f" && rm -f "$f.bak"
  echo "runtimeClassName -> $rc in k8s/06a-sandbox.yaml"
}

case "${1:-}" in
  runner)       shift; cmd_runner "$@" ;;
  image)        shift; cmd_image "$@" ;;
  runtimeclass) shift; cmd_runtimeclass "$@" ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
