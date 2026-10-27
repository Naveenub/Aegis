#!/usr/bin/env bash
# Provision the isolated Docker runner that sandbox.js talks to via DOCKER_HOST.
#
#   scripts/provision-runner.sh certs  <runner-hostname> [outdir]   # anywhere; makes CA + server + client certs
#       EXTRA_SANS="aegis-sandbox.aegis.svc,aegis-sandbox.aegis.svc.cluster.local" adds more DNS names (k8s)
#   sudo scripts/provision-runner.sh daemon [certdir]               # ON THE RUNNER; exposes dockerd on :2376 (mTLS only)
#
# The runner must be disposable and hold no secrets. Firewall 2376 to your
# Render outbound IPs: the Docker API is root on that machine.
# Upload ca.pem, cert.pem, key.pem (client files) as Render Secret Files.
set -euo pipefail

cmd="${1:-}"

case "$cmd" in
  certs)
    host="${2:?usage: $0 certs <runner-hostname> [outdir]}"
    out="${3:-./runner-certs}"
    mkdir -p "$out" && cd "$out" && umask 077
    openssl genrsa -out ca-key.pem 4096
    openssl req -new -x509 -days 365 -key ca-key.pem -sha256 -subj "/CN=aegis-runner-ca" -out ca.pem

    openssl genrsa -out server-key.pem 4096
    openssl req -new -key server-key.pem -subj "/CN=$host" -out server.csr
    sans="DNS:$host"
    for n in ${EXTRA_SANS//,/ }; do sans="$sans,DNS:$n"; done
    printf 'subjectAltName = %s\nextendedKeyUsage = serverAuth\n' "$sans" > server-ext.cnf
    openssl x509 -req -days 365 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem \
      -CAcreateserial -extfile server-ext.cnf -out server-cert.pem

    openssl genrsa -out key.pem 4096
    openssl req -new -key key.pem -subj "/CN=aegis-client" -out client.csr
    echo 'extendedKeyUsage = clientAuth' > client-ext.cnf
    openssl x509 -req -days 365 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem \
      -CAcreateserial -extfile client-ext.cnf -out cert.pem

    rm -f server.csr client.csr server-ext.cnf client-ext.cnf ca.srl
    echo "Done in $out. Server: ca.pem server-cert.pem server-key.pem. Client (Render): ca.pem cert.pem key.pem."
    echo "Keep ca-key.pem offline; certs expire in 365 days."
    ;;

  daemon)
    [ "$(id -u)" -eq 0 ] || { echo "run as root on the runner" >&2; exit 1; }
    src="${2:-.}"
    install -d -m 700 /etc/docker/certs
    install -m 600 "$src/ca.pem" "$src/server-cert.pem" "$src/server-key.pem" /etc/docker/certs/
    [ -f /etc/docker/daemon.json ] && cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
    cat > /etc/docker/daemon.json <<'JSON'
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
  "tlsverify": true,
  "tlscacert": "/etc/docker/certs/ca.pem",
  "tlscert": "/etc/docker/certs/server-cert.pem",
  "tlskey": "/etc/docker/certs/server-key.pem"
}
JSON
    # The stock unit passes -H fd://, which conflicts with "hosts" above.
    install -d /etc/systemd/system/docker.service.d
    printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd\n' > /etc/systemd/system/docker.service.d/aegis.conf
    systemctl daemon-reload && systemctl restart docker
    echo "dockerd now listens on :2376 with mutual TLS. Firewall it to Render's outbound IPs."
    ;;

  *) sed -n 2,9p "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
