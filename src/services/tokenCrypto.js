/**
 * Token Crypto
 *
 * Encrypts/decrypts Meta access tokens at rest using AES-256-GCM.
 * Requires TOKEN_ENCRYPTION_KEY in the environment -- the server refuses to
 * start without it (see requireEncryptionKey(), called from app.js) rather
 * than silently falling back to storing tokens in plaintext, which is the
 * exact defect this module replaces (the access_token_encrypted column
 * previously held raw plaintext despite its name).
 *
 * Storage format: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * The "enc:v1:" prefix lets decryptToken() distinguish already-encrypted
 * values from legacy plaintext rows written before this module existed,
 * so existing data keeps working during the one-time migration in
 * src/db/encryptLegacyTokens.js.
 */

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const PREFIX     = 'enc:v1:';
const IV_LENGTH  = 12; // 96-bit IV, recommended size for GCM

function requireEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Meta access tokens are encrypted at ' +
      'rest and the server cannot start without a key. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'and set TOKEN_ENCRYPTION_KEY to the output in your .env file.'
    );
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes as hex (got ${key.length} bytes). ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptToken(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const key = requireEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypt a stored token. Values without the enc:v1: prefix are treated as
 * legacy plaintext and returned unchanged -- this keeps existing rows
 * readable up until encryptLegacyTokens() re-encrypts them on boot, and
 * keeps the function safe to call even on a row that migration hasn't
 * reached yet for any reason.
 */
function decryptToken(stored) {
  if (stored === null || stored === undefined) return stored;
  if (!isEncrypted(stored)) return stored;

  const key = requireEncryptionKey();
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Stored token is malformed (expected iv:authTag:ciphertext).');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptToken, decryptToken, isEncrypted, requireEncryptionKey };
