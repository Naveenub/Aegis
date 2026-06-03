/**
 * vitest.config.js
 *
 * Vitest configuration for Aegis.
 *
 * Coverage
 * ────────
 * Provider: @vitest/coverage-v8 (V8's built-in coverage, zero extra deps at
 * runtime — just the devDependency).
 *
 * Thresholds (enforced — CI fails if any drops below):
 *   lines      80 %   – most practical signal; guards untested code paths
 *   functions  80 %   – every exported function must have at least one test
 *   branches   70 %   – slightly lower; many branches are defensive error guards
 *   statements 80 %   – mirrors lines in V8 coverage
 *
 * Thresholds are intentionally reachable with the existing 11-file test suite.
 * Raise them as coverage improves — never lower them.
 *
 * Include / exclude
 * ─────────────────
 * Only engine/ and middleware/ are measured — workers, CLI, scripts, and the
 * server entry point are excluded because they are thin orchestration wrappers
 * with minimal branching logic that is impractical to unit-test in isolation.
 *
 * Run coverage locally:
 *   npm run test:coverage          # collect + print summary table
 *   npm run test:coverage:ui       # open browser report (requires @vitest/ui)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ── Environment ─────────────────────────────────────────────────────────
    environment: 'node',

    // ── Test file pattern (vitest defaults — kept explicit for clarity) ──────
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', '.git', 'tests/integration/**'],

    // ── Coverage ─────────────────────────────────────────────────────────────
    coverage: {
      // V8 provider: uses Node's built-in V8 coverage — no babel transform
      // needed, accurate branch coverage, works with ESM out of the box.
      provider: 'v8',

      // Files to measure — engine/ is the core; middleware/ has the rate-limiter.
      // Exclude generated/vendored files and the dashboard HTML asset.
      include: ['engine/**/*.js', 'middleware/**/*.js'],
      exclude: [
        'engine/dashboard.html',
        'engine/sandbox.js',      // Docker wrapper — not unit-testable
        'engine/git-remote.js',   // thin git-remote shell wrapper
        'engine/logger.js',       // pino config — no logic to test
      ],

      // Output formats: text summary always printed; lcov for CI artifact upload.
      reporter: ['text', 'lcov', 'html'],

      // Where to write the HTML + lcov reports.
      reportsDirectory: './coverage',

      // ── Thresholds — CI fails if any metric drops below these values ───────
      thresholds: {
        lines:      80,
        functions:  80,
        branches:   70,
        statements: 80,
      },

      // Collect coverage even from files that are never imported by a test,
      // so untested modules show up as 0 % rather than being invisible.
      all: true,
    },
  },
});
