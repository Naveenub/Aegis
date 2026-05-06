import { execSync } from 'child_process';

export function runTests() {
  try {
    execSync('npm test', { stdio: 'pipe' });
    return { success: true, output: 'All tests passed' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString() || err.message
    };
  }
}
