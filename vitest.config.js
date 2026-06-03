/**
 * vitest.config.js
 *
 * Two projects:
 *
 *   unit        — fast mocked tests (existing suite), runs on every `npm test`
 *                 excludes tests/integration/** entirely
 *
 *   system      — real-infrastructure tests (Redis + git + filesystem)
 *                 lives in tests/integration/system/**
 *                 run via:  npm run test:system
 *                 or:       vitest run --project system
 *
 * Coverage is collected only over the unit project so mocked tests continue
 * to drive the thresholds.  System tests exercise the full stack and are
 * intentionally excluded from coverage (they can't meaningfully report on
 * mocked paths).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    projects: [
      // ── Unit / mocked tests ────────────────────────────────────────────────
      {
        name: 'unit',
        test: {
          include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
          exclude: [
            'node_modules',
            'dist',
            '.git',
            'tests/integration/system/**',
          ],
          coverage: {
            provider: 'v8',
            include: ['engine/**/*.js', 'middleware/**/*.js'],
            exclude: [
              'engine/dashboard.html',
              'engine/sandbox.js',
              'engine/git-remote.js',
              'engine/logger.js',
            ],
            reporter: ['text', 'lcov', 'html'],
            reportsDirectory: './coverage',
            thresholds: {
              lines:      80,
              functions:  80,
              branches:   70,
              statements: 80,
            },
            all: true,
          },
        },
      },

      // ── System / real-infrastructure tests ────────────────────────────────
      {
        name: 'system',
        test: {
          include: ['tests/integration/system/**/*.system.test.{js,ts}'],
          // Longer timeout — real Redis + git operations are slower than mocks
          testTimeout: 30000,
          // No coverage: system tests hit real I/O and can't meaningfully
          // measure which mocked paths were exercised.
          coverage: { enabled: false },
        },
      },
    ],
  },
});
