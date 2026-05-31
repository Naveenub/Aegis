import fs from 'fs';
import path from 'path';

/**
 * scanRepo(root?)
 *
 * Walk `root` (defaults to process.cwd() for backward-compat) and return
 * an array of absolute file paths, excluding node_modules and .git.
 *
 * Accepting an explicit `root` lets callers scope the scan to a tenant
 * worktree directory rather than the main repository working tree.
 *
 * @param {string} [root] - Absolute path to scan. Defaults to process.cwd().
 * @returns {string[]}
 */
export function scanRepo(root = process.cwd()) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // Directory vanished mid-walk (e.g. a worktree being torn down) — skip.
      return;
    }

    for (const file of entries) {
      const full = path.join(dir, file);

      if (file === 'node_modules' || file.startsWith('.git')) continue;

      try {
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else {
          files.push(full);
        }
      } catch {
        // stat failed (broken symlink, race condition, etc.) — skip.
      }
    }
  }

  walk(root);
  return files;
}
