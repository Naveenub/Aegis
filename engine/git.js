import { execSync } from 'child_process';

function run(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

// 📸 snapshot before change
export function createCheckpoint(message = 'aegis checkpoint') {
  run('git add -A');

  try {
    run(`git commit -m "${message}"`);
  } catch (err) {
    // nothing to commit (ignore)
  }

  const hash = run('git rev-parse HEAD').trim();
  return hash;
}

// 🔁 rollback
export function rollbackTo(hash) {
  run(`git reset --hard ${hash}`);
}

// 🧹 optional cleanup (later optimization)
export function softTag(name) {
  try {
    run(`git tag ${name}`);
  } catch {}
}
