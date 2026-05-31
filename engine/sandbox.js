import { execSync, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * sandbox.js
 *
 * Wraps every code-execution call (lint, test) in a Docker container so that
 * a malicious or buggy agent patch cannot escape the worktree, make network
 * calls, read host secrets, or consume unbounded CPU/memory.
 *
 * Why Docker instead of gVisor/nsjail?
 *   Docker is already a required dependency for Redis Stack. Adding a second
 *   runtime just for sandboxing is high friction. The constraints below
 *   (--network none, --read-only rootfs, --memory, --cpus, --security-opt
 *   no-new-privileges, dropped capabilities) provide strong isolation without
 *   requiring kernel patches or additional system daemons.
 *
 * Security properties of each sandboxed run:
 *   - Network is completely disabled (--network none).
 *   - The rootfs is read-only; only the worktree is bind-mounted rw.
 *   - node_modules from the host is bind-mounted read-only — no writes.
 *   - Max 512 MB RAM, 1 CPU, 60-second wall-clock timeout.
 *   - All Linux capabilities dropped; no new privileges.
 *   - Runs as nobody (uid 65534), not root.
 *   - /tmp is a tmpfs (64 MB max) so scratch space is size-capped.
 *
 * Degraded mode (AEGIS_SANDBOX_DISABLE=true):
 *   If Docker is not available (local dev, CI without Docker, test envs),
 *   set AEGIS_SANDBOX_DISABLE=true.  Execution falls back to the previous
 *   direct execSync calls with a strong warning logged at boot.
 *   Never set this in production.
 *
 * Environment variables:
 *   AEGIS_SANDBOX_DISABLE     'true' to skip Docker (dev/CI only)
 *   AEGIS_SANDBOX_IMAGE       Docker image to use (default: node:22-alpine)
 *   AEGIS_SANDBOX_MEMORY      Memory limit (default: 512m)
 *   AEGIS_SANDBOX_CPUS        CPU limit (default: 1)
 *   AEGIS_SANDBOX_TIMEOUT_MS  Wall-clock timeout ms (default: 60000)
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const DISABLED        = process.env.AEGIS_SANDBOX_DISABLE === 'true';
const IMAGE           = process.env.AEGIS_SANDBOX_IMAGE        ?? 'node:22-alpine';
const MEMORY          = process.env.AEGIS_SANDBOX_MEMORY       ?? '512m';
const CPUS            = process.env.AEGIS_SANDBOX_CPUS         ?? '1';
const TIMEOUT_MS      = parseInt(process.env.AEGIS_SANDBOX_TIMEOUT_MS ?? '60000');
const TMPFS_SIZE      = '67108864'; // 64 MB

// ─── Docker availability probe ────────────────────────────────────────────────

let _dockerAvailable = null;

function isDockerAvailable() {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

// ─── Boot warning ─────────────────────────────────────────────────────────────

if (DISABLED) {
  console.warn(
    '[sandbox] ⚠️  AEGIS_SANDBOX_DISABLE=true — code execution is UNSANDBOXED. ' +
    'Patches run directly on the host. Never use this setting in production.'
  );
} else if (!isDockerAvailable()) {
  console.warn(
    '[sandbox] ⚠️  Docker is not available — falling back to unsandboxed execution. ' +
    'Start Docker or set AEGIS_SANDBOX_DISABLE=true to suppress this warning. ' +
    'Set AEGIS_SANDBOX_DISABLE=true only for local dev — never in production.'
  );
}

// ─── Core runner ─────────────────────────────────────────────────────────────

/**
 * runInSandbox(cmd, opts)
 *
 * Run `cmd` (a shell string) inside a Docker container with the worktree
 * bind-mounted at the same absolute path it has on the host.
 *
 * When sandboxing is disabled or Docker is unavailable, falls back to a plain
 * execSync inside the worktree directory with a timeout and a NODE_OPTIONS
 * memory cap (best-effort — not a hard security boundary).
 *
 * @param {string}   cmd        - Shell command to run (e.g. 'npx eslint src/foo.js')
 * @param {string}   cwd        - Absolute path to the tenant worktree on the host.
 * @param {string}   projectRoot - Absolute path to the project root (for node_modules).
 * @returns {{ success: boolean, output: string }}
 */
export function runInSandbox(cmd, cwd, projectRoot) {
  const useSandbox = !DISABLED && isDockerAvailable();

  if (!useSandbox) {
    return runDirect(cmd, cwd);
  }

  return runDocker(cmd, cwd, projectRoot);
}

// ─── Docker execution ─────────────────────────────────────────────────────────

function runDocker(cmd, cwd, projectRoot) {
  // Resolve paths so bind mounts use canonical absolute paths.
  const absWorktree    = path.resolve(cwd);
  const absNodeModules = path.resolve(projectRoot, 'node_modules');

  // Validate both paths exist before constructing the docker command.
  if (!fs.existsSync(absWorktree)) {
    return { success: false, output: `Sandbox error: worktree not found: ${absWorktree}` };
  }
  if (!fs.existsSync(absNodeModules)) {
    return { success: false, output: `Sandbox error: node_modules not found: ${absNodeModules}` };
  }

  // Build the docker run arguments as an array to avoid shell injection
  // from cwd paths (path.resolve normalises, but explicit array is safer).
  const dockerArgs = [
    'run',
    '--rm',

    // ── Isolation ──────────────────────────────────────────────────────────
    '--network', 'none',                // no outbound network
    '--read-only',                      // rootfs is read-only
    '--tmpfs', `/tmp:size=${TMPFS_SIZE},mode=1777`, // writable scratch, size-capped
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', '65534:65534',            // nobody:nogroup

    // ── Resource limits ────────────────────────────────────────────────────
    '--memory', MEMORY,
    '--memory-swap', MEMORY,            // disable swap (swap = memory * 2 by default)
    '--cpus', CPUS,

    // ── Bind mounts ────────────────────────────────────────────────────────
    // Worktree: rw so tests/lint can write temp files (.vitest-cache etc.)
    '--volume', `${absWorktree}:${absWorktree}:rw`,
    // node_modules: ro — agents must not install packages
    '--volume', `${absNodeModules}:${absNodeModules}:ro`,

    // ── Working directory ──────────────────────────────────────────────────
    '--workdir', absWorktree,

    // ── Image + command ────────────────────────────────────────────────────
    IMAGE,
    'sh', '-c', cmd,
  ];

  try {
    const output = execFileSync('docker', dockerArgs, {
      stdio: 'pipe',
      timeout: TIMEOUT_MS,
      // No shell — we're using execFileSync with an explicit args array.
    });
    return { success: true, output: output.toString() || 'OK' };
  } catch (err) {
    const raw = err.stdout?.toString() || err.stderr?.toString() || err.message;
    const timedOut = err.signal === 'SIGTERM' || raw.includes('timeout');
    const msg = timedOut
      ? `Sandbox timeout after ${TIMEOUT_MS}ms:\n${raw}`
      : raw;
    return { success: false, output: msg };
  }
}

// ─── Direct (unsandboxed) fallback ────────────────────────────────────────────

function runDirect(cmd, cwd) {
  try {
    const output = execSync(cmd, {
      stdio: 'pipe',
      cwd,
      timeout: TIMEOUT_MS,
      // Best-effort memory cap via V8 flag — not a hard OS-level limit.
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=512`,
      },
    });
    return { success: true, output: output.toString() || 'OK' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString() || err.stderr?.toString() || err.message,
    };
  }
}

// ─── Capability probe (for /health) ──────────────────────────────────────────

/**
 * getSandboxCapabilities()
 *
 * Returns a structured object for the /health endpoint so operators can see
 * the sandbox state without SSHing into the host.
 *
 * @returns {{ enabled: boolean, docker: boolean, image: string, warnings: string[] }}
 */
export function getSandboxCapabilities() {
  const docker   = isDockerAvailable();
  const enabled  = !DISABLED && docker;
  const warnings = [];

  if (DISABLED) {
    warnings.push(
      'AEGIS_SANDBOX_DISABLE=true — all patch execution runs unsandboxed on the host. ' +
      'A malicious patch can read host files and environment variables.'
    );
  } else if (!docker) {
    warnings.push(
      'Docker is not available — patch execution is unsandboxed. ' +
      'Install Docker and ensure the daemon is running to enable sandboxing.'
    );
  }

  return { enabled, docker, image: IMAGE, memory: MEMORY, cpus: CPUS, warnings };
}
