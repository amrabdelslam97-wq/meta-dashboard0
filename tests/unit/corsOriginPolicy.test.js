'use strict';

const { parseAllowedOrigins, requestOrigin, isOriginAllowed } = require('../../src/middleware/corsOriginPolicy');

describe('corsOriginPolicy.parseAllowedOrigins', () => {
  test('empty/undefined env value yields an empty list', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  test('splits, trims, and drops blanks from a comma-separated list', () => {
    expect(parseAllowedOrigins('https://a.example.com, https://b.example.com ,,')).toEqual([
      'https://a.example.com', 'https://b.example.com',
    ]);
  });
});

describe('corsOriginPolicy.requestOrigin', () => {
  test('builds protocol://host from the request, whatever that host is', () => {
    expect(requestOrigin({ protocol: 'http', get: () => 'localhost:3000' })).toBe('http://localhost:3000');
    expect(requestOrigin({ protocol: 'http', get: () => '192.168.1.42:3000' })).toBe('http://192.168.1.42:3000');
    expect(requestOrigin({ protocol: 'https', get: () => 'ads.example.com' })).toBe('https://ads.example.com');
  });
});

describe('corsOriginPolicy.isOriginAllowed', () => {
  test('an empty Origin (no header) is always allowed', () => {
    expect(isOriginAllowed(undefined, 'http://localhost:3000', [])).toBe(true);
    expect(isOriginAllowed('', 'http://localhost:3000', [])).toBe(true);
  });

  test('an Origin matching the current server origin is allowed automatically -- localhost', () => {
    expect(isOriginAllowed('http://localhost:3000', 'http://localhost:3000', [])).toBe(true);
  });

  test('an Origin matching the current server origin is allowed automatically -- a local/LAN IP, with no hardcoding', () => {
    expect(isOriginAllowed('http://192.168.1.42:3000', 'http://192.168.1.42:3000', [])).toBe(true);
  });

  test('an Origin matching the current server origin is allowed automatically -- a production domain behind a reverse proxy', () => {
    expect(isOriginAllowed('https://ads.example.com', 'https://ads.example.com', [])).toBe(true);
  });

  test('a foreign origin is rejected when ALLOWED_ORIGINS is empty', () => {
    expect(isOriginAllowed('https://evil.example.com', 'http://localhost:3000', [])).toBe(false);
  });

  test('a foreign origin is allowed only when explicitly present in ALLOWED_ORIGINS', () => {
    expect(isOriginAllowed('https://trusted.example.com', 'http://localhost:3000', ['https://trusted.example.com'])).toBe(true);
    expect(isOriginAllowed('https://untrusted.example.com', 'http://localhost:3000', ['https://trusted.example.com'])).toBe(false);
  });

  test('a same-origin match still works even when ALLOWED_ORIGINS is configured with unrelated domains', () => {
    expect(isOriginAllowed('https://ads.example.com', 'https://ads.example.com', ['https://other-frontend.example.com'])).toBe(true);
  });
});
