'use strict';

/**
 * Private report access tokens (AGENT.md §10).
 *
 * Tokens are 256-bit random values, only ever shown to their owner once at
 * report creation. The database stores only a SHA-256 hash, so a leaked
 * database dump does not expose usable tokens. Raw tokens are never logged.
 */
const crypto = require('crypto');

const TOKEN_BYTES = 32;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function isValidTokenFormat(rawToken) {
  // base64url of 32 bytes is always 43 characters of [A-Za-z0-9_-]
  return typeof rawToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(rawToken);
}

function createAccessToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  if (!isValidTokenFormat(token)) {
    // Defensive: generation must always satisfy the format the lookup path trusts.
    throw new Error('Generated token does not match expected format');
  }
  return { token, tokenHash: hashToken(token) };
}

module.exports = { createAccessToken, hashToken, isValidTokenFormat };
