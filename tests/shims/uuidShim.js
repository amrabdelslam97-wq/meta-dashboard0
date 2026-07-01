'use strict';

// uuid@14 ships ESM-only (no CJS build) -- production code runs fine under
// plain `node` because Node 22+ transparently supports require()-ing ESM,
// but Jest's module loader does not. This shim maps `require('uuid')` to
// an equivalent CJS implementation for the test environment only; it is
// never loaded by the real app (see jest.config.js moduleNameMapper).
const crypto = require('crypto');

module.exports = { v4: () => crypto.randomUUID() };
