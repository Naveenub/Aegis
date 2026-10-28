import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { runInSandbox } from './sandbox.js';
import { ensureDeps, autoDepsEnabled } from './deps-cache.js';

/**
 * engine/toolchains.js
 *
 * Per-language lint/test profiles for the sandbox. Before this module every
 * lint/test run was hard-wired to ESLint + Vitest from Aegis's own
 * node_modules inside node:22-alpine, so a Python, Go or Java repo could not
 * run through the pipeline at all.
 *
 * A toolchain describes:
 *   • how to detect it from the tenant worktree (marker files at the root)
 *   • which Docker image runs it (overridable per language via env)
 *   • the lint command and the test command
 *   • what the container needs mounted (host node_modules, a dependency cache)
 *
 * Supported: node, python, go, java (Maven or Gradle).
 *
 * The sandbox runs with `--network none`, so nothing can be downloaded while
 * linting or testing. Dependencies are instead installed ahead of time by
 * engine/deps-cache.js — once per set of manifests, in a separate network-enabled
 * container working on a copy of the repo — and mounted read-only into the runs.
 * Each toolchain's `prepare` block says what to hash and how to install:
 *
 *   python  pytest + ruff + the repo's requirements*.txt / pyproject deps (pip --target)
 *   go      `go mod download` into a module cache (skipped when vendor/ is committed)
 *   java    Maven `dependency:go-offline`, or a Gradle resolve-all into a read-only cache
 *
 * To supply a cache yourself (or when AEGIS_SANDBOX_AUTO_DEPS=off), point one of
 * AEGIS_SANDBOX_PYTHON_DEPS / _GO_DEPS / _JAVA_DEPS at a host directory; it wins
 * over the automatic cache.
 *
 * Image overrides: AEGIS_SANDBOX_IMAGE (node, unchanged), AEGIS_SANDBOX_IMAGE_PYTHON,
 * AEGIS_SANDBOX_IMAGE_GO, AEGIS_SANDBOX_IMAGE_MAVEN, AEGIS_SANDBOX_IMAGE_GRADLE.
 */

// ─── helpers ──────────────────────────────────────────────────────────────────

/** POSIX single-quote a value so paths with spaces/metacharacters stay one argument. */
const q = (s) => `'${String(s).replace(/'/g, '\'\\\'\'')}'`;

/** Worktree-relative, forward-slash path for a file given relative or absolute. */
const rel = (cwd, f) => path.relative(cwd, path.resolve(cwd, f)).split(path.sep).join('/');

const has = (cwd, ...names) => names.some(n => fs.existsSync(path.join(cwd, n)));

function topLevelMatches(cwd, re) {
  try {
    return fs.readdirSync(cwd).some(n => re.test(n));
  } catch {
    return false;
  }
}

function depsDir(envKey) {
  const p = envKey ? process.env[envKey] : undefined;
  return p ? path.resolve(p) : null;
}

const stripExt = (file, re) => path.basename(file).replace(re, '');

// ─── Node ─────────────────────────────────────────────────────────────────────

const NODE = {
  id: 'node',
  label: 'JavaScript/TypeScript (Node)',
  image: () => process.env.AEGIS_SANDBOX_IMAGE ?? 'node:22-alpine',
  // ESLint and Vitest are Aegis's own binaries, run against the tenant's
  // worktree, so the host's node_modules has to be mounted read-only.
  hostNodeModules: true,
  sourceRe: /\.[cm]?[jt]sx?$/,
  testFileRe: /\.(test|spec)\.[cm]?[jt]sx?$/,
  baseName: (file) => stripExt(file, /\.[cm]?[jt]sx?$/).replace(/\.(test|spec)$/, ''),
  detect: (cwd) => has(cwd, 'package.json') || topLevelMatches(cwd, /\.[cm]?js$/),
  env: () => ({}),

  lintCommand({ cwd, files, projectRoot }) {
    const eslint = path.join(projectRoot, 'node_modules', '.bin', 'eslint');
    let targets = ['.'];
    if (files.length > 0) {
      targets = files.filter(f => NODE.sourceRe.test(f)).map(f => path.resolve(cwd, f));
      if (targets.length === 0) return null; // nothing ESLint can check in scope
    }
    return [eslint, '--resolve-plugins-relative-to', projectRoot, ...targets].map(q).join(' ');
  },

  testCommand({ cwd, projectRoot, targets }) {
    const vitest = path.join(projectRoot, 'node_modules', '.bin', 'vitest');
    return [vitest, 'run', '--root', cwd, '--reporter=verbose', ...targets].map(q).join(' ');
  },
};

// ─── Python ───────────────────────────────────────────────────────────────────

// Used when ruff is not in the image: a stdlib-only syntax check. Written to a
// heredoc so no quoting survives into the shell.
const PY_SYNTAX_CHECK = `import ast, os, sys
SKIP = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', 'vendor'}
bad = 0
def check(p):
    global bad
    try:
        with open(p, encoding='utf-8') as fh:
            ast.parse(fh.read(), p)
    except SyntaxError as e:
        bad = 1
        print('%s:%s: SyntaxError: %s' % (p, e.lineno, e.msg))
for t in sys.argv[1:]:
    if os.path.isdir(t):
        for root, dirs, names in os.walk(t):
            dirs[:] = [d for d in dirs if d not in SKIP]
            for n in names:
                if n.endswith('.py'):
                    check(os.path.join(root, n))
    else:
        check(t)
sys.exit(bad)`;

// Dependency install for Python, run with network access (see engine/deps-cache.js).
// pytest and ruff always go in; then the repo's own requirements.
const PY_PREP = `set -e
PIP="python3 -m pip install --no-input --upgrade --target $AEGIS_DEPS"
$PIP pytest ruff
python3 - <<'PY'
import os
try:
    import tomllib
except ImportError:
    tomllib = None
reqs = []
if tomllib and os.path.exists('pyproject.toml'):
    with open('pyproject.toml', 'rb') as fh:
        d = tomllib.load(fh)
    p = d.get('project', {})
    reqs += p.get('dependencies', [])
    opt = p.get('optional-dependencies', {})
    for k in ('test', 'tests', 'testing', 'dev'):
        reqs += opt.get(k, [])
    for k in ('test', 'tests', 'dev'):
        reqs += d.get('dependency-groups', {}).get(k, [])
reqs = [r for r in reqs if isinstance(r, str)]
with open('/tmp/aegis-req.txt', 'w') as out:
    out.write('\\n'.join(reqs) + ('\\n' if reqs else ''))
PY
if [ -s /tmp/aegis-req.txt ]; then $PIP -r /tmp/aegis-req.txt; fi
for f in requirements.txt requirements-dev.txt requirements-test.txt requirements_dev.txt requirements_test.txt; do
  if [ -f "$f" ]; then $PIP -r "$f"; fi
done`;

const PYTHON = {
  id: 'python',
  label: 'Python',
  // pytest and ruff come from the dependency cache (see `prepare`), so the stock
  // image is enough; without a cache it falls back to unittest + a syntax check.
  image: () => process.env.AEGIS_SANDBOX_IMAGE_PYTHON ?? 'python:3.12-alpine',
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_PYTHON_DEPS',
  sourceRe: /\.py$/,
  testFileRe: /(?:^|[\\/])(?:test_[^\\/]*|[^\\/]*_test)\.py$/,
  baseName: (file) => stripExt(file, /\.py$/).replace(/^test_/, '').replace(/_test$/, ''),
  prepare: {
    version: 1,
    manifestRe: /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile\.lock)$/,
    command: PY_PREP,
    env: () => ({ HOME: '/tmp', PIP_CACHE_DIR: '/tmp/pip-cache', PIP_DISABLE_PIP_VERSION_CHECK: '1' }),
  },
  detect: (cwd) => has(cwd, 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
                       'Pipfile', 'tox.ini', 'pytest.ini'),
  env: ({ cwd, deps }) => ({
    HOME: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: [cwd, path.join(cwd, 'src'), deps].filter(Boolean).join(':'),
  }),

  lintCommand({ cwd, files }) {
    let targets = ['.'];
    if (files.length > 0) {
      targets = files.map(f => rel(cwd, f)).filter(f => PYTHON.sourceRe.test(f));
      if (targets.length === 0) return null;
    }
    const t = targets.map(q).join(' ');
    // ruff only when the repo configures it, so a repo that uses flake8/black
    // isn't suddenly held to ruff's default rules.
    const ruffConfigured = "{ [ -f ruff.toml ] || [ -f .ruff.toml ] || grep -qs '^\\[tool\\.ruff' pyproject.toml; }";
    return [
      `if ${ruffConfigured} && python3 -m ruff --version >/dev/null 2>&1; then python3 -m ruff check ${t}; else`,
      `python3 - ${t} <<'PY'`,
      PY_SYNTAX_CHECK,
      'PY',
      'fi',
    ].join('\n');
  },

  testCommand({ cwd, targets }) {
    const rels = targets.map(f => rel(cwd, f));
    const pytest = ['python3 -m pytest -q -p no:cacheprovider', ...rels.map(q)].join(' ');
    // `unittest discover` skips directories without __init__.py, so name the
    // modules explicitly (namespace packages import fine).
    const modules = rels.map(f => f.replace(/\.py$/, '').split('/').join('.'));
    const unittest = modules.length > 0
      ? ['python3 -m unittest -v', ...modules.map(q)].join(' ')
      : 'python3 -m unittest discover -v';
    return `if python3 -c 'import pytest' >/dev/null 2>&1; then ${pytest}; else ${unittest}; fi`;
  },
};

// ─── Go ───────────────────────────────────────────────────────────────────────

const GO = {
  id: 'go',
  label: 'Go',
  image: () => process.env.AEGIS_SANDBOX_IMAGE_GO ?? 'golang:1.23-alpine',
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_GO_DEPS',
  memory: '1g',
  tmpfsBytes: 268435456, // GOCACHE lives in /tmp
  sourceRe: /\.go$/,
  testFileRe: /_test\.go$/,
  baseName: (file) => stripExt(file, /\.go$/).replace(/_test$/, ''),
  prepare: {
    version: 1,
    manifestRe: /(^|\/)go\.(mod|sum)$/,
    // A committed vendor/ already carries the dependencies; so does a module with no requires.
    needed: (cwd, manifests) => !has(cwd, 'vendor/modules.txt') &&
      manifests.some(f => path.basename(f) === 'go.mod' && /^\s*require\b/m.test(fs.readFileSync(f, 'utf-8'))),
    command: 'go mod download',
    env: ({ cache }) => ({
      HOME: '/tmp',
      GOCACHE: '/tmp/go-build',
      GOPATH: '/tmp/go',
      GOMODCACHE: cache,
      GOPROXY: process.env.AEGIS_SANDBOX_GOPROXY ?? 'https://proxy.golang.org',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-buildvcs=false',
      CGO_ENABLED: '0',
    }),
  },
  detect: (cwd) => has(cwd, 'go.mod'),
  env: ({ deps }) => ({
    HOME: '/tmp',
    GOCACHE: '/tmp/go-build',
    GOPATH: '/tmp/go',
    GOMODCACHE: deps ?? '/tmp/go/pkg/mod',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-buildvcs=false', // worktree's .git points outside the mount
    CGO_ENABLED: '0',           // alpine has no C toolchain
  }),

  lintCommand({ cwd, files }) {
    let goFiles = [];
    if (files.length > 0) {
      goFiles = files.map(f => rel(cwd, f)).filter(f => GO.sourceRe.test(f));
      if (goFiles.length === 0) return null;
    }
    const fmt = goFiles.length > 0
      ? `out=$(gofmt -l ${goFiles.map(q).join(' ')})`
      : 'list=$(find . -name \'*.go\' -not -path \'./vendor/*\' -not -path \'./.git/*\'); ' +
        'if [ -n "$list" ]; then out=$(gofmt -l $list); else out=; fi';
    const pkgs = goFiles.length > 0
      ? [...new Set(goFiles.map(f => path.posix.dirname(f)))]
          .map(d => q(d === '.' ? './' : `./${d}`)).join(' ')
      : './...';
    return [
      fmt,
      'if [ -n "$out" ]; then echo "gofmt: these files need formatting:"; echo "$out"; exit 1; fi',
      `go vet ${pkgs}`,
    ].join('\n');
  },

  testCommand({ cwd, targets, scoped }) {
    if (!scoped || targets.length === 0) return 'go test -count=1 ./...';
    const dirs = [...new Set(targets.map(f => path.posix.dirname(rel(cwd, f))))];
    return `go test -count=1 ${dirs.map(d => q(d === '.' ? './' : `./${d}`)).join(' ')}`;
  },
};

// ─── Java ─────────────────────────────────────────────────────────────────────

const JAVA_COMMON = {
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_JAVA_DEPS',
  requiresDeps: true,
  requiresDepsMessage:
    'Java builds need an offline dependency cache because the sandbox has no network ' +
    '(Maven/Gradle cannot even fetch their own plugins). It is built automatically unless ' +
    'AEGIS_SANDBOX_AUTO_DEPS=off; in that case set AEGIS_SANDBOX_JAVA_DEPS to a host directory ' +
    'populated ahead of time — a Maven local repository, or for Gradle the directory ' +
    'containing modules-2 — and Aegis mounts it read-only into the container.',
  memory: '1g',
  timeoutMs: 180000,
  tmpfsBytes: 268435456,
  sourceRe: /\.java$/,
  testFileRe: /[\\/]src[\\/]test[\\/](?:.*[\\/])?(?:\w*(?:Test|Tests|IT)|Test\w+)\.java$/,
  baseName: (file) => stripExt(file, /\.java$/).replace(/(Tests?|IT)$/, '').replace(/^Test/, ''),
};

const javaClass = (f) => path.basename(f).replace(/\.java$/, '');

const MVN_PREP = `set -e
mvn -B -ntp -Dmaven.repo.local="$AEGIS_DEPS" dependency:go-offline
mvn -B -ntp -Dmaven.repo.local="$AEGIS_DEPS" -Dtest=__aegis_none__ -Dsurefire.failIfNoSpecifiedTests=false -DfailIfNoTests=false test || true`;

// Resolves every resolvable configuration of every project (build scripts, plugins,
// compile and test runtime classpaths) so the offline runs find them.
const GRADLE_PREP = `set -e
cat > /tmp/aegis-resolve.gradle <<'G'
allprojects {
  tasks.register('aegisResolveAll') {
    doLast {
      configurations.matching { it.canBeResolved }.each { c -> try { c.resolve() } catch (ignored) { } }
    }
  }
}
G
gradle --no-daemon -q --init-script /tmp/aegis-resolve.gradle aegisResolveAll`;

const MAVEN = {
  ...JAVA_COMMON,
  id: 'java-maven',
  label: 'Java (Maven)',
  gitIgnore: ['target/'],
  prepare: {
    version: 1,
    manifestRe: /(^|\/)pom\.xml$/,
    command: MVN_PREP,
    env: () => ({ HOME: '/tmp' }),
  },
  image: () => process.env.AEGIS_SANDBOX_IMAGE_MAVEN ?? 'maven:3.9-eclipse-temurin-21',
  detect: (cwd) => has(cwd, 'pom.xml'),
  env: () => ({ HOME: '/tmp' }),

  lintCommand({ files, deps }) {
    if (files.length > 0 && !files.some(f => JAVA_COMMON.sourceRe.test(f))) return null;
    // No standard linter ships with Maven; compiling main + test sources is the
    // gate that catches what a patch most often breaks.
    return `mvn -o -B -ntp -q ${mvnRepo(deps)} test-compile`;
  },

  testCommand({ targets, scoped, deps }) {
    const filter = scoped && targets.length > 0
      ? ` -Dtest=${[...new Set(targets.map(javaClass))].join(',')} -Dsurefire.failIfNoSpecifiedTests=false`
      : '';
    return `mvn -o -B -ntp ${mvnRepo(deps)}${filter} test`;
  },
};
const mvnRepo = (deps) => `-Dmaven.repo.local=${q(deps)}`;

const GRADLE = {
  ...JAVA_COMMON,
  id: 'java-gradle',
  label: 'Java (Gradle)',
  gitIgnore: ['build/', '.gradle/'],
  prepare: {
    version: 1,
    manifestRe: /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml)$/,
    command: GRADLE_PREP,
    env: ({ cache }) => ({ HOME: '/tmp', GRADLE_USER_HOME: cache }),
    // GRADLE_RO_DEP_CACHE wants the directory that contains modules-2
    depsPath: (cache) => path.join(cache, 'caches'),
  },
  image: () => process.env.AEGIS_SANDBOX_IMAGE_GRADLE ?? 'gradle:8-jdk21',
  detect: (cwd) => has(cwd, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'),
  env: ({ deps }) => ({
    HOME: '/tmp',
    GRADLE_USER_HOME: '/tmp/gradle-home',
    GRADLE_RO_DEP_CACHE: deps,
  }),

  lintCommand({ files }) {
    if (files.length > 0 && !files.some(f => JAVA_COMMON.sourceRe.test(f))) return null;
    return 'gradle --offline --no-daemon -q classes testClasses';
  },

  testCommand({ targets, scoped }) {
    const filter = scoped && targets.length > 0
      ? [...new Set(targets.map(javaClass))].map(c => ` --tests ${q(c)}`).join('')
      : '';
    return `gradle --offline --no-daemon test${filter}`;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const TOOLCHAINS = { node: NODE, python: PYTHON, go: GO, 'java-maven': MAVEN, 'java-gradle': GRADLE };

/**
 * detectToolchains(cwd)
 *
 * Every toolchain whose marker files exist at the worktree root, so a repo
 * with both package.json and go.mod runs both. Maven wins over Gradle when
 * both are present. An empty array means no supported language was found.
 *
 * @param {string} cwd
 * @returns {object[]}
 */
export function detectToolchains(cwd) {
  const found = [NODE, PYTHON, GO].filter(tc => tc.detect(cwd));
  if (MAVEN.detect(cwd)) found.push(MAVEN);
  else if (GRADLE.detect(cwd)) found.push(GRADLE);
  return found;
}

/**
 * Result for a worktree with no supported language. Fails by default so a patch
 * that could not be verified is never committed as if it had passed; set
 * AEGIS_SANDBOX_ALLOW_UNSUPPORTED=true to skip instead.
 *
 * @param {string} kind  'lint' | 'tests'
 * @returns {{ success: boolean, output: string }}
 */
export function noToolchainResult(kind) {
  const base =
    '[toolchain] No supported language detected at the worktree root ' +
    '(looked for package.json, pyproject.toml/setup.py/requirements.txt, go.mod, pom.xml, build.gradle)';
  const allow = /^(1|true|yes|on)$/i.test(process.env.AEGIS_SANDBOX_ALLOW_UNSUPPORTED ?? '');
  return allow
    ? { success: true, output: `${base} — ${kind} skipped (AEGIS_SANDBOX_ALLOW_UNSUPPORTED is set).` }
    : {
        success: false,
        output: `${base}, so ${kind} could not run and the change is unverified. ` +
                'Set AEGIS_SANDBOX_ALLOW_UNSUPPORTED=true to skip instead of failing.',
      };
}

/**
 * prepareToolchain(tc, ctx)
 *
 * Resolve the dependency directory for a toolchain: an operator-supplied
 * AEGIS_SANDBOX_*_DEPS wins, then the automatic cache (building it on first use),
 * else none. Call once per toolchain per lint/test run.
 *
 * @param {object} tc
 * @param {{ cwd: string, projectRoot: string, tenantId?: string }} ctx
 * @returns {{ deps: string|null, error?: string }}
 */
export function prepareToolchain(tc, ctx) {
  let deps = depsDir(tc.depsEnvKey);

  if (!deps && tc.prepare && autoDepsEnabled()) {
    const r = ensureDeps(tc, ctx);
    if (r.error) return { deps: null, error: r.error };
    deps = r.dir;
  }

  if (tc.requiresDeps && !deps) {
    return { deps: null, error: `[toolchain:${tc.id}] ${tc.requiresDepsMessage}` };
  }
  return { deps };
}

// Build output must not be swept into agent commits (`git add -A`), so keep it
// out of the repo's untracked set. Best effort; tracked files are unaffected.
const _excluded = new Set();
function excludeFromGit(cwd, patterns = []) {
  for (const pattern of patterns) {
    const key = `${path.resolve(cwd)}\0${pattern}`;
    if (_excluded.has(key)) continue;
    _excluded.add(key);
    try {
      const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, stdio: 'pipe' })
        .toString().trim();
      const file = path.resolve(cwd, rel);
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      if (!current.split('\n').includes(pattern)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
      }
    } catch {
      // not a git checkout, or git unavailable — nothing to do
    }
  }
}

/**
 * runToolchainCommand(tc, cmd, ctx)
 *
 * Run one lint/test command for a toolchain through the sandbox (no network)
 * with the right image, mounts, env and limits.
 *
 * @param {object} tc
 * @param {string} cmd
 * @param {{ cwd: string, projectRoot: string, tenantId?: string, deps?: string|null }} ctx
 * @returns {{ success: boolean, output: string }}
 */
export function runToolchainCommand(tc, cmd, { cwd, projectRoot, tenantId, deps = null }) {
  excludeFromGit(cwd, tc.gitIgnore);
  return runInSandbox(cmd, cwd, projectRoot, tenantId, {
    toolchain: tc.id,
    image: tc.image(),
    hostNodeModules: Boolean(tc.hostNodeModules),
    deps,
    env: tc.env({ cwd, deps }),
    memory: tc.memory,
    timeoutMs: tc.timeoutMs,
    tmpfsBytes: tc.tmpfsBytes,
  });
}
