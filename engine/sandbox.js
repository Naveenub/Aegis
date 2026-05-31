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
 * Security model — two allowed states, one hard-blocked state:
 *
 *   ALLOWED:   Docker is available → runDocker() (fully sandboxed)
 *   ALLOWED:   Docker is unavailable AND AEGIS_SANDBOX_DISABLE=true
 *              → runDirect() with a loud warning (explicit operator opt-in)
 *   HARD FAIL: Docker is unavailable AND AEGIS_SANDBOX_DISABLE is not 'true'
 *              → throw at call-time; the step fails safely rather than
 *                running unsandboxed code on the host silently.
 *
 * The previous behaviour — silently falling back to execSync when Docker was
 * absent — meant any environment without Docker (a dev laptop, a CI runner,
 * a misconfigured prod host) would execute agent-generated code directly on
 * the host. A boot warning is not an enforcement mechanism.
 *
 * Migration: if you run without Docker intentionally (local dev, CI),
 * set AEGIS_SANDBOX_DISABLE=true in your .env. The hard-fail message tells
 * you exactly this, so the fix path is unambiguous.
 *
 * Environment variables:
 *   AEGIS_SANDBOX_DISABLE     'true' to allow unsandboxed execution (dev/CI only)
 *   AEGIS_SANDBOX_IMAGE       Docker image to use (default: node:22-alpine)
 *   AEGIS_SANDBOX_MEMORY      Memory limit (default: 512m)
 *   AEGIS_SANDBOX_CPUS        CPU limit (default: 1)
 *   AEGIS_SANDBOX_TIMEOUT_MS  Wall-clock timeout ms (default: 60000)
 *
 * Security properties of each sandboxed run:
 *   - Network is completely disabled (--network none).
 *   - The rootfs is read-only; only the worktree is bind-mounted rw.
 *   - node_modules from the host is bind-mounted read-only — no writes.
 *   - Max 512 MB RAM, 1 CPU, 60-second wall-clock timeout.
 *   - All Linux capabilities dropped; no new privileges.
 *   - Runs as nobody (uid 65534), not root.
 *   - /tmp is a tmpfs (64 MB max) so scratch space is size-capped.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const DISABLE_EXPLICITLY = process.env.AEGIS_SANDBOX_DISABLE === 'true';
const IMAGE              = process.env.AEGIS_SANDBOX_IMAGE        ?? 'node:22-alpine';
const MEMORY             = process.env.AEGIS_SANDBOX_MEMORY       ?? '512m';
const CPUS               = process.env.AEGIS_SANDBOX_CPUS         ?? '1';
const TIMEOUT_MS         = parseInt(process.env.AEGIS_SANDBOX_TIMEOUT_MS ?? '60000');
const TMPFS_SIZE         = '67108864'; // 64 MB

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

// ─── Boot diagnostics ─────────────────────────────────────────────────────────
// Log the sandbox state once at import time so operators see it in startup logs.
// Hard-fail decisions are made at call-time (runInSandbox), not here, so the
// server can still start and report /health even if Docker is absent.

if (DISABLE_EXPLICITLY) {
  console.warn(
    '[sandbox] ⚠️  AEGIS_SANDBOX_DISABLE=true — unsandboxed execution ENABLED. ' +
    'Patches run directly on the host. NEVER use this setting in production.'
  );
} else if (!isDockerAvailable()) {
  console.error(
    '[sandbox] ✖  Docker is not available and AEGIS_SANDBOX_DISABLE is not set. ' +
    'Any call to runInSandbox() will FAIL rather than run unsandboxed. ' +
    'Fix: start Docker, or set AEGIS_SANDBOX_DISABLE=true for local dev only.'
  );
}

// ─── Core runner ─────────────────────────────────────────────────────────────

/**
 * runInSandbox(cmd, cwd, projectRoot)
 *
 * Enforcement rules (evaluated in order):
 *   1. Docker available                         → runDocker()   ✅ sandboxed
 *   2. Docker unavailable + DISABLE_EXPLICITLY  → runDirect()   ⚠️  warned
 *   3. Docker unavailable + no explicit opt-in  → hard fail     ✖  blocked
 *
 * Rule 3 is the fix: previously this case silently fell through to runDirect().
 * Now it returns a failure result so the worker rolls back the step cleanly
 * rather than executing untrusted code on the host.
 *
 * @param {string} cmd         - Shell command to run
 * @param {string} cwd         - Absolute path to the tenant worktree on the host
 * @param {string} projectRoot - Absolute path to the project root (for node_modules)
 * @returns {{ success: boolean, output: string }}
 */
export function runInSandbox(cmd, cwd, projectRoot) {
  const dockerAvailable = isDockerAvailable();

  // ── Rule 1: Docker is up — always sandbox ────────────────────────────────
  if (dockerAvailable) {
    return runDocker(cmd, cwd, projectRoot);
  }

  // ── Rule 2: No Docker, but operator explicitly opted out of sandboxing ───
  if (DISABLE_EXPLICITLY) {
    return runDirect(cmd, cwd);
  }

  // ── Rule 3: No Docker, no explicit opt-in — hard fail ───────────────────
  // This is the enforcement fix. Returning { success: false } causes the
  // worker's review pipeline to reject the patch and trigger a retry or DLQ
  // routing — the same path as a lint failure. No host code execution occurs.
  return {
    success: false,
    output:
      '[sandbox] Execution blocked: Docker is not available and ' +
      'AEGIS_SANDBOX_DISABLE=true has not been set.\n' +
      'To fix: start Docker (recommended), or set AEGIS_SANDBOX_DISABLE=true ' +
      'in .env for local dev only. Never set AEGIS_SANDBOX_DISABLE=true in production.',
  };
}

// ─── Docker execution ─────────────────────────────────────────────────────────

function runDocker(cmd, cwd, projectRoot) {
  const absWorktree    = path.resolve(cwd);
  const absNodeModules = path.resolve(projectRoot, 'node_modules');

  if (!fs.existsSync(absWorktree)) {
    return { success: false, output: `Sandbox error: worktree not found: ${absWorktree}` };
  }
  if (!fs.existsSync(absNodeModules)) {
    return { success: false, output: `Sandbox error: node_modules not found: ${absNodeModules}` };
  }

  const dockerArgs = [
    'run',
    '--rm',

    // ── Isolation ──────────────────────────────────────────────────────────
    '--network', 'none',
    '--read-only',
    '--tmpfs', `/tmp:size=${TMPFS_SIZE},mode=1777`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', '65534:65534',

    // ── Resource limits ────────────────────────────────────────────────────
    '--memory', MEMORY,
    '--memory-swap', MEMORY,
    '--cpus', CPUS,

    // ── Bind mounts ────────────────────────────────────────────────────────
    '--volume', `${absWorktree}:${absWorktree}:rw`,
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
// Only reachable when AEGIS_SANDBOX_DISABLE=true is explicitly set (Rule 2).

function runDirect(cmd, cwd) {
  try {
    const output = execSync(cmd, {
      stdio: 'pipe',
      cwd,
      timeout: TIMEOUT_MS,
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
 * Returns a structured object for the /health endpoint.
 * The new `enforced` field tells operators whether the hard-fail rule is active:
 *   enforced: true  → Docker absent without opt-in will block execution (safe)
 *   enforced: false → either Docker is up (safe) or DISABLE_EXPLICITLY (warned)
 *
 * @returns {{ enabled: boolean, enforced: boolean, docker: boolean, image: string, warnings: string[] }}
 */
export function getSandboxCapabilities() {
  const docker   = isDockerAvailable();
  const enabled  = docker || DISABLE_EXPLICITLY;  // will execution proceed at all?
  const enforced = !docker && !DISABLE_EXPLICITLY; // is the hard-fail rule active?
  const warnings = [];

  if (DISABLE_EXPLICITLY) {
    warnings.push(
      'AEGIS_SANDBOX_DISABLE=true — all patch execution runs unsandboxed on the host. ' +
      'A malicious patch can read host files and environment variables.'
    );
  } else if (!docker) {
    warnings.push(
      'Docker is not available — runInSandbox() will BLOCK execution rather than ' +
      'run unsandboxed. Start Docker to restore normal operation, or set ' +
      'AEGIS_SANDBOX_DISABLE=true for local dev only.'
    );
  }

  return { enabled, enforced, docker, image: IMAGE, memory: MEMORY, cpus: CPUS, warnings };
}
