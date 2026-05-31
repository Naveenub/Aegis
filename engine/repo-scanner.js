import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

// Directories that are never worth descending into.
const PRUNE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'coverage']);

/**
 * scanRepo(root?)
 *
 * Async directory walk. Returns a promise that resolves to an array of
 * absolute file paths, excluding the directories in PRUNE_DIRS.
 *
 * Uses `fs.promises.readdir` with `{ withFileTypes: true }` so each entry
 * already knows whether it is a file or a directory — no extra `stat` call
 * per entry. This removes the main source of event-loop blocking on large
 * repositories (the old implementation called `fs.readdirSync` and
 * `fs.statSync` on every single entry, stalling the event loop for the
 * entire duration of the walk).
 *
 * The walk is breadth-first. A queue is used instead of recursion so there
 * is no risk of stack overflow on very deep directory trees.
 *
 * @param {string} [root] - Absolute path to scan. Defaults to process.cwd().
 * @returns {Promise<string[]>}
 */
export async function scanRepo(root = process.cwd()) {
  const files = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();

    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory vanished mid-walk (e.g. a worktree being torn down) — skip.
      continue;
    }

    for (const entry of entries) {
      if (PRUNE_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
      // Symlinks and other exotic types are silently skipped.
    }
  }

  return files;
}

/**
 * scanRepoSync(root?)
 *
 * Synchronous fallback used only by `engine/test-runner.js`, which runs
 * inside a Docker sandbox via `child_process.execSync` — an already-blocked
 * context where async I/O is not available.
 *
 * All other callers MUST use the async `scanRepo` instead.
 *
 * The implementation is identical to the original except it prunes the same
 * extended PRUNE_DIRS set and skips symlinks instead of stat-following them.
 *
 * @param {string} [root] - Absolute path to scan. Defaults to process.cwd().
 * @returns {string[]}
 */
export function scanRepoSync(root = process.cwd()) {
  const files = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (PRUNE_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}
