/**
 * vitest.workspace.js
 *
 * Vitest 1.x requires projects to be defined via a workspace file
 * (vitest.workspace.{js,ts}) rather than inside the `test.projects` key of
 * vitest.config.js.  This file replaces the non-functional `projects` array
 * that was previously inside vitest.config.js.
 *
 * Projects:
 *   unit    — fast mocked tests, run on every `npm test`
 *   system  — real-infrastructure tests (Redis + git), run via `npm run test:system`
 */

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // ── Unit / mocked tests ─────────────────────────────────────────────────────
  {
    test: {
      name: 'unit',
      environment: 'node',
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

  // ── System / real-infrastructure tests ──────────────────────────────────────
  {
    test: {
      name: 'system',
      environment: 'node',
      include: ['tests/integration/system/**/*.system.test.{js,ts}'],
      // Longer timeout — real Redis + git operations are slower than mocks
      testTimeout: 30000,
      // No coverage: system tests hit real I/O and can't meaningfully
      // measure which mocked paths were exercised.
      coverage: { enabled: false },
    },
  },
]);
