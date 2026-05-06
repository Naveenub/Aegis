import { execSync } from 'child_process';

function run(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

/**
 * 🌿 Create or checkout workflow branch
 */
export function ensureWorkflowBranch(workflowId) {
  const branch = `aegis/${workflowId}`;

  try {
    // check if branch exists
    run(`git rev-parse --verify ${branch}`);
    run(`git checkout ${branch}`);
  } catch {
    // create new branch from main
    run(`git checkout main`);
    run(`git checkout -b ${branch}`);
  }

  return branch;
}

/**
 * 📸 Commit changes inside workflow branch
 */
export function commitChanges(message) {
  run('git add -A');

  try {
    run(`git commit -m "${message}"`);
  } catch {
    // nothing to commit (safe ignore)
  }
}

/**
 * 🔁 Rollback last commit (safe inside branch)
 */
export function rollbackLastCommit() {
  try {
    run('git reset --hard HEAD~1');
  } catch {
    // nothing to rollback
  }
}

/**
 * 🔀 Merge workflow branch into main (squash)
 */
export function mergeWorkflow(workflowId) {
  const branch = `aegis/${workflowId}`;

  run('git checkout main');

  // squash merge keeps history clean
  run(`git merge --squash ${branch}`);

  run(`git commit -m "Aegis merge: ${branch}"`);
}

/**
 * 🧹 Delete workflow branch after merge
 */
export function cleanupWorkflowBranch(workflowId) {
  const branch = `aegis/${workflowId}`;

  try {
    run(`git branch -D ${branch}`);
  } catch {
    // ignore if already deleted
  }
}

/**
 * 📌 Optional tag (for debugging / checkpoints)
 */
export function softTag(name) {
  try {
    run(`git tag ${name}`);
  } catch {}
}
