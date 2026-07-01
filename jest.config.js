'use strict';

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // uuid@14 is ESM-only (no CJS build); Node's own require(esm) support
  // covers the real app, but Jest's loader needs an explicit CJS shim.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/shims/uuidShim.js',
  },
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/app.js',
  ],
  coverageDirectory: 'coverage',
  testTimeout: 15000,
  // sql.js loads the same file lock/module cache across test files if run
  // in parallel workers sharing a temp path; each test file gets its own
  // temp DB file (see tests/helpers/testDb.js) so this is mainly to keep
  // console output from Meta API retry/backoff tests readable.
  verbose: false,
};
