'use strict';

// Deterministic 32-byte test key -- same requirements as production
// (TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes as hex), just
// fixed instead of random so encrypted fixtures are reproducible.
process.env.TOKEN_ENCRYPTION_KEY =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'.slice(0, 64);
process.env.NODE_ENV = 'test';

// Deterministic session secret -- same requirement as production (server
// refuses to start without SESSION_SECRET), just fixed for reproducibility.
// Auth itself is bypassed under NODE_ENV=test (see src/middleware/auth.js),
// so this only needs to satisfy the boot-time presence check.
process.env.SESSION_SECRET = 'test-session-secret-not-for-production-use';

// Quiet the migration/seed console.log noise every test file's DB setup
// produces -- console.warn/error stay untouched so real defensive-check
// warnings and error paths are still visible in test output.
global.console.log = () => {};
