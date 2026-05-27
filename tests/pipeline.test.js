import { describe, it, expect } from 'vitest';
import { validatePatch } from '../engine/review-system.js';

// ---------------------------------------------------------------------------
// validatePatch
// ---------------------------------------------------------------------------
describe('validatePatch', () => {
  it('rejects non-JSON input', () => {
    const result = validatePatch('not json');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/REJECTED/);
  });

  it('rejects a patch missing the content field', () => {
    const result = validatePatch(JSON.stringify({ file: 'src/foo.js' }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid patch format/);
  });

  it('rejects a patch missing the file field', () => {
    const result = validatePatch(JSON.stringify({ content: 'console.log(1)' }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid patch format/);
  });

  it('rejects a path-traversal file field', () => {
    const result = validatePatch(
      JSON.stringify({ file: '../../etc/passwd', content: 'x' })
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unsafe file path/);
  });

  it('rejects a patch whose content exceeds the size limit', () => {
    const result = validatePatch(
      JSON.stringify({ file: 'src/foo.js', content: 'x'.repeat(50001) })
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Patch too large/);
  });
});