/**
 * bench/lib/exec.js — run shell commands for a task, on the host or in Docker.
 *
 * Task commands (`setup`, `fail_to_pass`, `pass_to_pass`) execute a third-party
 * repo's own build and test scripts. They come from manifests we curate and
 * review, but they are still third-party code: run the benchmark in a
 * disposable VM/container, or pass `docker: { image }` so setup runs in a
 * throwaway container (network on) and tests run with `--network none`.
 */

import { spawnSync } from 'child_process';

/**
 * @param {string} cmd  shell command
 * @param {object} o
 * @param {string} o.cwd
 * @param {number} [o.timeoutSec=900]
 * @param {boolean} [o.network=true]
 * @param {{image:string}|null} [o.docker]
 * @returns {{ code: number|null, timedOut: boolean, output: string }}
 */
export function sh(cmd, { cwd, timeoutSec = 900, network = true, docker = null, env = {} }) {
  let file = 'sh';
  let args = ['-c', cmd];
  if (docker?.image) {
    const uid = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
    file = 'docker';
    args = [
      'run', '--rm', '--user', uid, '-e', 'HOME=/tmp', '-e', 'CI=true',
      ...(network ? [] : ['--network', 'none']),
      '-v', `${cwd}:/work`, '-w', '/work', docker.image, 'sh', '-c', cmd,
    ];
  }
  const r = spawnSync(file, args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: 'true', ...env },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    code: r.status,
    timedOut: r.error?.code === 'ETIMEDOUT',
    output: output.length > 20_000 ? `…${output.slice(-20_000)}` : output,
  };
}

/** Run git, throw on failure. */
export function git(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * Fetch exactly one commit of a GitHub repo into `dir` and check it out on a
 * local branch named `main`. Works for any reachable sha (GitHub allows it).
 */
export function checkoutSha({ repo, sha, dir, remote = `https://github.com/${repo}.git` }) {
  git(['init', '-q', '-b', 'main', dir], process.cwd());
  git(['config', 'user.email', 'bench@aegis.local'], dir);
  git(['config', 'user.name', 'Aegis Bench'], dir);
  git(['remote', 'add', 'origin', remote], dir);
  git(['fetch', '-q', '--depth', '1', 'origin', sha], dir);
  git(['checkout', '-q', '-B', 'main', sha], dir);
}

/** Apply a patch file to the working tree (and index so it can be committed). */
export function applyPatch(dir, patchPath) {
  git(['apply', '--index', '--whitespace=nowarn', patchPath], dir);
}
