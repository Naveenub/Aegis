/**
 * vitest.config.js
 *
 * Shared Vitest configuration.  Project definitions (unit / system) live in
 * vitest.workspace.js, which Vitest 1.x picks up automatically when running
 * `vitest run --project <name>`.
 *
 * This file is kept for any global overrides (e.g. global setup files) that
 * apply across all projects.  Currently there are none, so it simply re-exports
 * the defaults so that tools that look for vitest.config.js still find a valid
 * configuration file.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
