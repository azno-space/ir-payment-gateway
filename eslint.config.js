'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Files over 200 lines that were reviewed and kept, each with its reason. Only shrinks;
// max-lines stays a warning everywhere, never a build break. tests/sizeAllowlist.test.js keeps the list honest.
const sizeAllowlist = Object.keys(require('./size-allowlist.json'));

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Cyclomatic complexity 10 and nesting depth 3 are the limits for new code. They are warnings
      // where large files remain and errors in src/ (the override below).
      complexity: ['warn', 10],
      'max-depth': ['warn', 3],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'max-lines': ['warn', 200],
    },
  },
  { files: sizeAllowlist, rules: { 'max-lines': 'off' } },
  {
    // The public part is fully split now: its limits are enforced.
    files: ['src/**/*.js'],
    rules: { complexity: ['error', 10], 'max-depth': ['error', 3] },
  },
  {
    files: ['**/tests/**', '**/*.test.js', '**/*.test.cjs'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { complexity: 'off', 'max-depth': 'off', 'max-lines': 'off' },
  },
];
