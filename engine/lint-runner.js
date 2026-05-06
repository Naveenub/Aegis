import { execSync } from 'child_process';

export function runLint() {
  try {
    execSync('npm run lint', { stdio: 'pipe' });
    return { success: true, output: 'Lint passed' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString() || err.message
    };
  }
}
