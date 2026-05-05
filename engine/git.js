import { execSync } from 'child_process';

export function commit(msg) {
  execSync('git add .');
  execSync(`git commit -m "${msg}"`);
}
