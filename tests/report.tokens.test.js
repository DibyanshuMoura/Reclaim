'use strict';

const crypto = require('crypto');
const {
  createAccessToken,
  hashToken,
  isValidTokenFormat,
} = require('../src/modules/reports/report.tokens');

describe('report tokens', () => {
  it('hashes with sha256 correctly (known vector)', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('creates 43-character base64url tokens with a matching hash', () => {
    const { token, tokenHash } = createAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashToken(token));
  });

  it('generates unguessable, unique tokens across many draws', () => {
    const tokens = new Set(Array.from({ length: 250 }, () => createAccessToken().token));
    expect(tokens.size).toBe(250);
  });

  it('validates the token lookup format strictly', () => {
    expect(isValidTokenFormat(createAccessToken().token)).toBe(true);
    expect(isValidTokenFormat('short')).toBe(false);
    expect(isValidTokenFormat('a'.repeat(43) + '!')).toBe(false);
    expect(isValidTokenFormat('a'.repeat(43))).toBe(true);
    expect(isValidTokenFormat(undefined)).toBe(false);
  });
});
