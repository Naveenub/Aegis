/** @type {import('eslint').Linter.Config} */
module.exports = {
  env: {
    es2022: true,
    node:   true,
  },
  parserOptions: {
    ecmaVersion:  2022,
    sourceType:  'module',
  },
  overrides: [
    {
      files: ['dashboard/src/**/*.js', 'dashboard/src/**/*.jsx'],
      env: { browser: true },
    },
  ],
  rules: {
    // ── Error-class rules ──────────────────────────────────────────────────
    'no-unused-vars': ['error', {
      vars:               'all',
      args:               'after-used',
      ignoreRestSiblings: true,
      // Express error-handler signature requires 4 args; allow leading _
      argsIgnorePattern:  '^_',
    }],
    'no-undef':          'error',
    'no-duplicate-case': 'error',
    'no-unreachable':    'error',

    // ── Best-practice warnings ─────────────────────────────────────────────
    // Allow console.warn / console.error in engine modules for boot diagnostics;
    // flag plain console.log so structured pino logging is preferred.
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

    'eqeqeq':   ['warn', 'always', { null: 'ignore' }],
    'no-var':    'warn',
    'prefer-const': ['warn', { destructuring: 'all' }],

    // ── Style (non-blocking) ───────────────────────────────────────────────
    'semi':   ['warn', 'always'],
    'quotes': ['warn', 'single', { avoidEscape: true }],
  },
};
