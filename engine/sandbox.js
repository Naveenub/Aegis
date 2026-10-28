import { execSync, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { recordUsageEvent, EVENT_TYPES } from './usage-recorder.js';

/**
 * sandbox.js
 *
 * Wraps every code-execution call (lint, test) in a Docker container so that
 * a malicious or buggy agent patch cannot escape the worktree, make network
 * calls, read host secrets, or consume unbounded CPU/memory.
 *
 * Security model — three allowed states, one hard-blocked state:
 *
 *   ALLOWED:   Docker is available
 *              → runDocker()  ✅ fully sandboxed (always preferred)
 *
 *   ALLOWED:   Docker is unavailable AND AEGIS_SANDBOX_MODE=local
 *              → runDirect()  ⚠️  explicit local-dev/CI opt-in, loud warning
 *
 *   ALLOWED:   Docker is unavailable AND AEGIS_SANDBOX_DISABLE=true
 *              → runDirect()  ⚠️  legacy opt-in, loud warning (still supported)
 *
 *   ALLOWED:   Docker is unavailable AND CI=true env var is set
 *              → runDirect()  ⚠️  auto-detected CI environment, loud warning
 *              (Standard CI platforms — GitHub Actions, GitLab CI, CircleCI,
 *               Jenkins, Travis, Buildkite, etc. — all export CI=true. Docker-
 *               in-Docker is possible in CI but often unavailable or slow.)
 *
 *   HARD FAIL: Docker is unavailable AND none of the above opt-ins are active
 *              → throw at call-time so the step fails safely rather than
 *                running unsandboxed code on the host silently.
 *
 * Languages: the image, mounts, env and limits for a run come from the caller
 * (see engine/toolchains.js — node, python, go, java). A run only needs the
 * host's node_modules when its toolchain says so (ESLint/Vitest are Aegis's own
 * binaries); Python/Go/Java runs do not.
 *
 * Migration: set AEGIS_SANDBOX_MODE=local in your .env (preferred) or
 * AEGIS_SANDBOX_DISABLE=true (legacy) for local dev without Docker.
 * CI pipelines are detected automatically via the CI environment variable.
 *
 * Environment variables:
 *   AEGIS_SANDBOX_MODE        'local' to allow unsandboxed execution (dev only)
 *   AEGIS_SANDBOX_DISABLE     'true' legacy alias for AEGIS_SANDBOX_MODE=local
 *   CI                        'true' auto-set by most CI platforms — enables
 *                             unsandboxed fallback automatically in pipelines
 *   AEGIS_SANDBOX_IMAGE       Docker image for the node toolchain (default: node:22-alpine)
 *                             (other languages: AEGIS_SANDBOX_IMAGE_PYTHON / _GO / _MAVEN / _GRADLE)
 *   AEGIS_SANDBOX_MEMORY      Memory limit (default: 512m; Go/Java default to 1g unless set)
 *   AEGIS_SANDBOX_CPUS        CPU limit (default: 1)
 *   AEGIS_SANDBOX_TIMEOUT_MS  Wall-clock timeout ms (default: 60000; Java defaults to 180000 unless set)
 *
 * Security properties of each sandboxed run:
 *   - Network is completely disabled (--network none).
 *   - The rootfs is read-only; only the worktree is bind-mounted rw.
 *   - node_modules from the host is bind-mounted read-only for toolchains that
 *     need it (node); an optional dependency cache is mounted read-only too.
 *   - Max 512 MB RAM, 1 CPU, 60-second wall-clock timeout.
 *   - All Linux capabilities dropped; no new privileges.
 *   - Runs as nobody (uid 65534), not root.
 *   - /tmp is a tmpfs (64 MB max) so scratch space is size-capped.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const DISABLE_EXPLICITLY = process.env.AEGIS_SANDBOX_DISABLE === 'true';
const LOCAL_MODE         = process.env.AEGIS_SANDBOX_MODE === 'local';
const IN_CI              = process.env.CI === 'true';

// Any of these signals that the operator has consciously accepted unsandboxed
// execution — or that we are in a standard CI environment where Docker is
// unavailable and unsandboxed execution is an acceptable trade-off.
const UNSANDBOXED_OK = DISABLE_EXPLICITLY || LOCAL_MODE || IN_CI;

const IMAGE      = process.env.AEGIS_SANDBOX_IMAGE        ?? 'node:22-alpine';
const MEMORY     = process.env.AEGIS_SANDBOX_MEMORY       ?? '512m';
const CPUS       = process.env.AEGIS_SANDBOX_CPUS         ?? '1';
const TIMEOUT_MS = parseInt(process.env.AEGIS_SANDBOX_TIMEOUT_MS ?? '60000');
const TMPFS_SIZE = '67108864'; // 64 MB

// An explicitly set env var always beats a toolchain's own default (Go/Java need
// more memory and time than a lint run of JS), so an operator can still cap them.
const MEMORY_SET  = process.env.AEGIS_SANDBOX_MEMORY !== undefined;
const TIMEOUT_SET = process.env.AEGIS_SANDBOX_TIMEOUT_MS !== undefined;
const PULL_TIMEOUT_MS = 600000; // first use of a language image downloads it

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
    '[sandbox] ⚠️  AEGIS_SANDBOX_DISABLE=true — unsandboxed execution ENABLED (legacy flag). ' +
    'Prefer AEGIS_SANDBOX_MODE=local for new configurations. ' +
    'Patches run directly on the host. NEVER use this setting in production.'
  );
} else if (LOCAL_MODE) {
  console.warn(
    '[sandbox] ⚠️  AEGIS_SANDBOX_MODE=local — unsandboxed execution ENABLED. ' +
    'Patches run directly on the host. For local dev only; NEVER use in production.'
  );
} else if (IN_CI && !isDockerAvailable()) {
  console.warn(
    '[sandbox] ⚠️  CI=true detected and Docker is unavailable — falling back to ' +
    'unsandboxed execution. Patches run directly on the CI host. ' +
    'For full isolation in CI, configure Docker-in-Docker (dind).'
  );
} else if (!isDockerAvailable()) {
  console.error(
    '[sandbox] ✖  Docker is not available and no unsandboxed fallback is configured. ' +
    'Any call to runInSandbox() will FAIL rather than run unsandboxed. ' +
    'Fix options:\n' +
    '  • Start Docker (recommended for production)\n' +
    '  • Set AEGIS_SANDBOX_MODE=local in .env (local dev without Docker)\n' +
    '  • CI environments are detected automatically via CI=true'
  );
}

// ─── Core runner ─────────────────────────────────────────────────────────────

/**
 * runInSandbox(cmd, cwd, projectRoot)
 *
 * Enforcement rules (evaluated in order):
 *   1. Docker available                  → runDocker()   ✅ sandboxed
 *   2. Docker unavailable + UNSANDBOXED_OK → runDirect() ⚠️  warned
 *   3. Docker unavailable + no opt-in    → hard fail     ✖  blocked
 *
 * @param {string} cmd         - Shell command to run
 * @param {string} cwd         - Absolute path to the tenant worktree on the host
 * @param {string} projectRoot - Absolute path to the project root (for node_modules)
 * @param {string} [tenantId]  - Tenant to attribute sandbox-minutes usage to.
 *                               Optional so existing callers (tests, direct
 *                               script invocations) keep working unmetered.
 * @param {object} [opts]      - Per-run toolchain settings (all optional; the
 *                               defaults reproduce the original node behaviour):
 * @param {string}  [opts.image]           Docker image (default AEGIS_SANDBOX_IMAGE)
 * @param {boolean} [opts.hostNodeModules] Mount <projectRoot>/node_modules ro and
 *                                         fail if it is missing (default true)
 * @param {string}  [opts.deps]            Host dir mounted read-only at the same path
 * @param {Object<string,string>} [opts.env] Environment for the command (container
 *                                         env, or merged over process.env when direct)
 * @param {string}  [opts.memory]          Toolchain default memory (env var wins)
 * @param {number}  [opts.timeoutMs]       Toolchain default timeout (env var wins)
 * @param {number}  [opts.tmpfsBytes]      /tmp size in bytes (default 64 MB)
 * @param {string}  [opts.toolchain]       Label recorded in usage metadata
 * @returns {{ success: boolean, output: string }}
 */
export function runInSandbox(cmd, cwd, projectRoot, tenantId, opts = {}) {
  const dockerAvailable = isDockerAvailable();
  const startedAt = Date.now();
  const timeoutMs = TIMEOUT_SET ? TIMEOUT_MS : (opts.timeoutMs ?? TIMEOUT_MS);

  const result = dockerAvailable
    ? runDocker(cmd, cwd, projectRoot, opts, timeoutMs)
    : UNSANDBOXED_OK
      ? runDirect(cmd, cwd, opts, timeoutMs)
      : {
          success: false,
          output:
            '[sandbox] Execution blocked: Docker is not available and no unsandboxed ' +
            'fallback is configured.\n\n' +
            'Fix options:\n' +
            '  • Start Docker (recommended for production)\n' +
            '  • Set AEGIS_SANDBOX_MODE=local in .env  (local dev without Docker)\n' +
            '  • CI pipelines are detected automatically via the CI=true env var\n' +
            '    (GitHub Actions, GitLab CI, CircleCI, Travis CI, Buildkite, etc.)\n\n' +
            'Never set AEGIS_SANDBOX_MODE=local or AEGIS_SANDBOX_DISABLE=true in production.',
        };

  // Billable regardless of pass/fail — the container/process still consumed
  // wall-clock time. Not billable when execution was blocked outright (rule
  // 3): nothing ran, so there's nothing to meter.
  const blocked = !dockerAvailable && !UNSANDBOXED_OK;
  if (tenantId && !blocked) {
    const minutes = (Date.now() - startedAt) / 60000;
    recordUsageEvent({
      tenantId,
      eventType: EVENT_TYPES.SANDBOX_MINUTES,
      quantity: minutes,
      metadata: {
        mode: dockerAvailable ? 'docker' : 'direct',
        ...(opts.toolchain ? { toolchain: opts.toolchain } : {}),
      },
    });
  }

  return result;
}

// ─── Docker execution ─────────────────────────────────────────────────────────

function ensureWorktreeWritable(absWorktree) {
  try {
    fs.chmodSync(absWorktree, 0o777);
    for (const entry of fs.readdirSync(absWorktree)) {
      const entryPath = path.join(absWorktree, entry);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue;
      fs.chmodSync(entryPath, stat.isDirectory() ? 0o777 : 0o666);
      if (stat.isDirectory()) ensureWorktreeWritable(entryPath);
    }
  } catch (err) {
    // Non-fatal — worst case the container hits the same EACCES it would
    // have hit anyway, which runDocker already reports as a normal failure.
    console.warn(`[sandbox] Could not chmod worktree for container write access: ${err.message}`);
  }
}

// Make sure the image is local before `docker run`, so a first-time pull of a
// large language image (golang, maven) is not charged against the run timeout.
const _imagesReady = new Set();

function ensureImage(image) {
  if (_imagesReady.has(image)) return null;
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe', timeout: 10000 });
    _imagesReady.add(image);
    return null;
  } catch {
    // not present locally — pull below
  }
  try {
    execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: PULL_TIMEOUT_MS });
    _imagesReady.add(image);
    return null;
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    return `Sandbox error: image ${image} is not available locally and could not be pulled: ${detail}`;
  }
}

function runDocker(cmd, cwd, projectRoot, opts = {}, timeoutMs = TIMEOUT_MS) {
  const absWorktree = path.resolve(cwd);
  const needsNodeModules = opts.hostNodeModules ?? true;
  const absNodeModules = path.resolve(projectRoot, 'node_modules');
  const absDeps = opts.deps ? path.resolve(opts.deps) : null;
  const image = opts.image ?? IMAGE;
  const memory = MEMORY_SET ? MEMORY : (opts.memory ?? MEMORY);
  const tmpfsSize = String(opts.tmpfsBytes ?? TMPFS_SIZE);

  if (!fs.existsSync(absWorktree)) {
    return { success: false, output: `Sandbox error: worktree not found: ${absWorktree}` };
  }
  if (needsNodeModules && !fs.existsSync(absNodeModules)) {
    return { success: false, output: `Sandbox error: node_modules not found: ${absNodeModules}` };
  }
  if (absDeps && !fs.existsSync(absDeps)) {
    return { success: false, output: `Sandbox error: dependency cache not found: ${absDeps}` };
  }

  const pullError = ensureImage(image);
  if (pullError) return { success: false, output: pullError };

  // The container runs as uid 65534 ("nobody"), but the worktree is created
  // on the host by whatever user owns the Aegis process (the CI runner user,
  // a service account, etc). Docker bind mounts preserve host permissions,
  // so without this the container falls into the "other" permission bucket
  // and — depending on the host's umask — may only have read/execute, not
  // write, causing every write inside the worktree to fail with EACCES.
  // Widening to world-writable is safe here: --network none plus the
  // dropped capabilities mean nothing outside this container can exploit it,
  // and the worktree is disposable per-workflow scratch space, not a shared
  // or long-lived directory.
  ensureWorktreeWritable(absWorktree);

  const envArgs = Object.entries(opts.env ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .flatMap(([k, v]) => ['--env', `${k}=${v}`]);

  const dockerArgs = [
    'run',
    '--rm',

    // ── Isolation ──────────────────────────────────────────────────────────
    '--network', 'none',
    '--read-only',
    '--tmpfs', `/tmp:size=${tmpfsSize},mode=1777`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', '65534:65534',

    // ── Resource limits ────────────────────────────────────────────────────
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', CPUS,

    // ── Bind mounts ────────────────────────────────────────────────────────
    '--volume', `${absWorktree}:${absWorktree}:rw`,
    ...(needsNodeModules ? ['--volume', `${absNodeModules}:${absNodeModules}:ro`] : []),
    ...(absDeps ? ['--volume', `${absDeps}:${absDeps}:ro`] : []),

    // ── Environment ────────────────────────────────────────────────────────
    ...envArgs,

    // ── Working directory ──────────────────────────────────────────────────
    '--workdir', absWorktree,

    // ── Image + command ────────────────────────────────────────────────────
    image,
    'sh', '-c', cmd,
  ];

  try {
    const output = execFileSync('docker', dockerArgs, {
      stdio: 'pipe',
      timeout: timeoutMs,
    });
    return { success: true, output: output.toString() || 'OK' };
  } catch (err) {
    const raw = err.stdout?.toString() || err.stderr?.toString() || err.message;
    // Node's execFileSync throws `Error: spawnSync docker ETIMEDOUT` (err.code
    // === 'ETIMEDOUT') when its own `timeout` option fires — err.signal isn't
    // reliably 'SIGTERM' on that path, and the message contains "ETIMEDOUT",
    // not the substring "timeout", so both prior checks missed it.
    const timedOut =
      err.signal === 'SIGTERM' ||
      err.code === 'ETIMEDOUT' ||
      raw.toLowerCase().includes('timeout') ||
      raw.toLowerCase().includes('timedout');
    const msg = timedOut
      ? `Sandbox timeout after ${timeoutMs}ms:\n${raw}`
      : raw;
    return { success: false, output: msg };
  }
}

// ─── Direct (unsandboxed) fallback ────────────────────────────────────────────
// Only reachable when UNSANDBOXED_OK is true (Rules 2).

function runDirect(cmd, cwd, opts = {}, timeoutMs = TIMEOUT_MS) {
  try {
    const output = execSync(cmd, {
      stdio: 'pipe',
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        NODE_OPTIONS: '--max-old-space-size=512',
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
 *
 * Fields:
 *   enabled   — will execution proceed at all (Docker up, or unsandboxed fallback active)?
 *   enforced  — is the hard-fail rule active? true = Docker absent with no opt-in
 *   docker    — is Docker currently reachable?
 *   mode      — 'docker' | 'local' | 'ci' | 'disabled' | 'blocked'
 *   image     — configured Docker image (when mode === 'docker')
 *   warnings  — human-readable strings for ops dashboards
 *
 * @returns {{ enabled: boolean, enforced: boolean, docker: boolean, mode: string, image: string, warnings: string[] }}
 */
export function getSandboxCapabilities() {
  const docker   = isDockerAvailable();
  const enabled  = docker || UNSANDBOXED_OK;
  const enforced = !docker && !UNSANDBOXED_OK;
  const warnings = [];

  let mode;
  if (docker) {
    mode = 'docker';
  } else if (LOCAL_MODE) {
    mode = 'local';
    warnings.push(
      'AEGIS_SANDBOX_MODE=local — all patch execution runs unsandboxed on the host. ' +
      'A malicious patch can read host files and environment variables.'
    );
  } else if (DISABLE_EXPLICITLY) {
    mode = 'disabled';
    warnings.push(
      'AEGIS_SANDBOX_DISABLE=true — all patch execution runs unsandboxed on the host (legacy flag). ' +
      'A malicious patch can read host files and environment variables. ' +
      'Prefer AEGIS_SANDBOX_MODE=local for new configurations.'
    );
  } else if (IN_CI) {
    mode = 'ci';
    warnings.push(
      'CI=true detected without Docker — patch execution runs unsandboxed on the CI host. ' +
      'For full isolation, configure Docker-in-Docker (dind) in your pipeline.'
    );
  } else {
    mode = 'blocked';
    warnings.push(
      'Docker is not available — runInSandbox() will BLOCK execution rather than ' +
      'run unsandboxed. Start Docker to restore normal operation, or set ' +
      'AEGIS_SANDBOX_MODE=local for local dev only.'
    );
  }

  return { enabled, enforced, docker, mode, image: IMAGE, memory: MEMORY, cpus: CPUS, warnings };
}
