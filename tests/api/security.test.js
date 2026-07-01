'use strict';

const request = require('supertest');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');
const { rejectMockInProduction } = require('../../src/services/mockGuard');

describe('API security: helmet headers + CORS', () => {
  let testDb;
  let app;

  beforeAll(async () => {
    testDb = await createTestDb();
    app = createApp();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  test('responses include helmet security headers', async () => {
    const res = await request(app).get('/api/v1/campaigns');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  test('a same-origin request (no Origin header) is allowed', async () => {
    const res = await request(app).get('/api/v1/campaigns');
    expect(res.status).toBe(200);
  });

  test('a disallowed cross-origin request is rejected with 403', async () => {
    const res = await request(app)
      .get('/api/v1/campaigns')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Origin not allowed');
  });

  test('an explicitly allowed origin (ALLOWED_ORIGINS) is accepted', async () => {
    const original = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://trusted.example.com';
    try {
      const allowlistedApp = createApp();
      const res = await request(allowlistedApp)
        .get('/api/v1/campaigns')
        .set('Origin', 'https://trusted.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://trusted.example.com');
    } finally {
      process.env.ALLOWED_ORIGINS = original;
    }
  });
});

describe('API security: rate limiting (SEC-M4)', () => {
  let testDb;
  let app;
  let originalNodeEnv;

  beforeAll(async () => {
    testDb = await createTestDb();
    // Rate limiting is intentionally disabled under NODE_ENV=test (a full
    // Supertest run legitimately exceeds the sync limiter's 20-request
    // ceiling); temporarily switch to 'development' so this describe
    // block exercises the real, production-equivalent limiter behavior.
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    app = createApp();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    testDb.cleanup();
  });

  test('the sync endpoint enforces its own tighter rate limit (20/15min) independent of general API traffic', async () => {
    let sawRateLimited = false;
    for (let i = 0; i < 22; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/api/v1/sync/status');
      if (res.status === 429) { sawRateLimited = true; break; }
    }
    expect(sawRateLimited).toBe(true);
  });
});

describe('mockGuard.rejectMockInProduction', () => {
  function fakeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  test('rejects mock=true with 403 when NODE_ENV=production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const req = { query: { mock: 'true' } };
      const res = fakeRes();
      const handled = rejectMockInProduction(req, res);
      expect(handled).toBe(true);
      expect(res.status).toHaveBeenCalledWith(403);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test('allows mock=true when NODE_ENV is not production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const req = { query: { mock: 'true' } };
      const res = fakeRes();
      const handled = rejectMockInProduction(req, res);
      expect(handled).toBe(false);
      expect(res.status).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test('does nothing when mock is not requested, regardless of environment', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const req = { query: {} };
      const res = fakeRes();
      expect(rejectMockInProduction(req, res)).toBe(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
