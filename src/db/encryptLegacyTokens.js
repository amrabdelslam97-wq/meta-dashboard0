/**
 * One-time migration: encrypt any legacy plaintext access tokens.
 *
 * Idempotent by construction (not by a schema_migrations flag) -- it scans
 * every ad_accounts row and re-encrypts only those whose
 * access_token_encrypted value doesn't already carry the enc:v1: prefix,
 * so it is always safe to call on every boot even after all rows have
 * already been migrated (it will simply find nothing to do).
 */

const db = require('./database');
const { encryptToken, isEncrypted } = require('../services/tokenCrypto');

function encryptLegacyTokens() {
  const accounts = db.all('SELECT id, access_token_encrypted FROM ad_accounts');

  let migrated = 0;
  for (const acct of accounts) {
    if (!acct.access_token_encrypted || isEncrypted(acct.access_token_encrypted)) continue;
    const encrypted = encryptToken(acct.access_token_encrypted);
    db.run('UPDATE ad_accounts SET access_token_encrypted = ? WHERE id = ?', [encrypted, acct.id]);
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[DB] Encrypted ${migrated} legacy plaintext access token(s).`);
  }
}

module.exports = { encryptLegacyTokens };
