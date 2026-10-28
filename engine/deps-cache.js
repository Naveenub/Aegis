import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runInSandbox } from './sandbox.js';
import { scanRepoSync } from './repo-scanner.js';

/**
 * engine/deps-cache.js
 *
 * Lint and test runs have no network, so Python/Go/Java dependencies can't be
 * fetched where they are needed. This module fetches them once, in a separate
 * install step, and hands the result to the runs as a read-only mount:
 *
 *   1. Hash the repo's dependency manifests (requirements*.txt, pyproject.toml,
 *      go.mod/go.sum, pom.xml, build.gradle*, …) together with the toolchain
 *      image. Same manifests → same cache; a cache hit costs one stat().
 *   2. On a miss, copy the worktree to a scratch directory and run the
 *      toolchain's install command there in the toolchain image, with network
 *      access. The container still drops all capabilities, runs as nobody, has
 *      a read-only rootfs, and sees only that scratch copy and the cache
 *      directory being filled — no host env, no secrets, no real worktree.
 *   3. Publish the finished cache with an atomic rename, so concurrent workers
 *      never see a half-written cache.
 *
 * The install step does run the repo's own build tooling with network access
 * (pip building an sdist, Maven/Gradle plugins), the same exposure as any CI
 * dependency install. Set AEGIS_SANDBOX_AUTO_DEPS=off to disable it and supply
 * caches yourself with AEGIS_SANDBOX_{PYTHON,GO,JAVA}_DEPS.
 *
 * Config:
 *   AEGIS_SANDBOX_AUTO_DEPS        off | false | 0 disables the install step
 *   AEGIS_DEPS_CACHE_DIR           cache root (default: <tmpdir>/aegis-deps)
 *   AEGIS_SANDBOX_DEPS_TIMEOUT_MS  install timeout (default 600000)
 */

const COPY_EXCLUDE = new Set([
  '.git', 'node_modules', 'target', 'build', '.gradle', '__pycache__', '.venv', 'venv', '.tox',
]);

export const autoDepsEnabled = () => !/^(off|false|0|no)$/i.test(process.env.AEGIS_SANDBOX_AUTO_DEPS ?? '');

const cacheRoot = () => path.resolve(process.env.AEGIS_DEPS_CACHE_DIR ?? path.join(os.tmpdir(), 'aegis-deps'));
const installTimeout = () => parseInt(process.env.AEGIS_SANDBOX_DEPS_TIMEOUT_MS ?? '600000', 10);

/** Remove a directory even when the toolchain made it read-only (Go's module cache does). */
function removeDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    try {
      execFileSync('chmod', ['-R', 'u+w', p], { stdio: 'ignore' });
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // leave it; a stray temp dir is harmless
    }
  }
}

/**
 * depsKey(tc, cwd, manifests)
 * Stable hash of the manifests' paths and contents, the toolchain and its image.
 */
export function depsKey(tc, cwd, manifests) {
  const h = crypto.createHash('sha256');
  h.update(`${tc.id}\0${tc.image()}\0${tc.prepare.version ?? 1}\0`);
  for (const f of [...manifests].sort()) {
    h.update(`${path.relative(cwd, f)}\0`);
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * ensureDeps(tc, ctx)
 *
 * @param {object} tc  Toolchain with a `prepare` block (see engine/toolchains.js)
 * @param {{ cwd: string, projectRoot: string, tenantId?: string }} ctx
 * @returns {{ dir: string|null, error?: string }}
 *   dir   — host directory to mount read-only, or null when nothing is needed
 *   error — human-readable failure; the caller fails the step with it
 */
export function ensureDeps(tc, { cwd, projectRoot, tenantId }) {
  const prep = tc.prepare;
  if (!prep) return { dir: null };

  const manifests = scanRepoSync(cwd).filter(f => prep.manifestRe.test(path.relative(cwd, f).split(path.sep).join('/')));
  if (prep.needed && !prep.needed(cwd, manifests)) return { dir: null };

  const key = depsKey(tc, cwd, manifests);
  const finalDir = path.join(cacheRoot(), tc.id, key);
  const resolved = (d) => ({ dir: prep.depsPath ? prep.depsPath(d) : d });

  if (fs.existsSync(path.join(finalDir, '.ready'))) return resolved(finalDir);

  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  const tmpDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.chmodSync(tmpDir, 0o777); // the container runs as uid 65534

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-depsrc-'));
  const cleanup = () => { removeDir(copy); };

  try {
    fs.cpSync(cwd, copy, {
      recursive: true,
      filter: (src) => !COPY_EXCLUDE.has(path.basename(src)),
    });

    const result = runInSandbox(prep.command, copy, projectRoot, tenantId, {
      toolchain: `${tc.id}-deps`,
      image: tc.image(),
      hostNodeModules: false,
      network: true,
      rwMounts: [tmpDir],
      env: { AEGIS_DEPS: tmpDir, ...prep.env({ cache: tmpDir }) },
      memory: tc.memory,
      tmpfsBytes: tc.tmpfsBytes,
      exactTimeoutMs: installTimeout(),
    });

    if (!result.success) {
      removeDir(tmpDir);
      return {
        dir: null,
        error: `[deps:${tc.id}] Installing dependencies failed (this step has network access; ` +
               `lint/tests were not run):\n${result.output.slice(-3000)}`,
      };
    }

    fs.writeFileSync(path.join(tmpDir, '.ready'), `${new Date().toISOString()}\n`);
    try {
      fs.renameSync(tmpDir, finalDir);
    } catch {
      removeDir(tmpDir); // another worker published the same cache first — use theirs
    }
    return resolved(finalDir);
  } catch (err) {
    removeDir(tmpDir);
    return { dir: null, error: `[deps:${tc.id}] Could not prepare dependencies: ${err.message}` };
  } finally {
    cleanup();
  }
}
