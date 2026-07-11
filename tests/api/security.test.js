'use strict';

const http = require('http');
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

// Regression coverage for the "Origin not allowed" bug: a same-origin
// POST/PATCH/DELETE (e.g. the dashboard's own "Add Account" Save button)
// was previously rejected because browsers attach an Origin header to
// those even when same-origin, and the old static allowlist had no
// same-origin exception at all. These tests bind a REAL listening server
// (not supertest's default ephemeral-per-call server) so the Origin header
// can be set to exactly match the server's own address, proving the
// same-origin match is computed dynamically -- never a hardcoded
// "localhost" -- for whatever host the request actually arrives on.
describe('CORS: dynamic same-origin allowance (no hardcoded origins)', () => {
  let testDb;
  let server;
  let port;

  beforeAll(async () => {
    testDb = await createTestDb();
    server = http.createServer(createApp());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    testDb.cleanup();
    await new Promise(resolve => server.close(resolve));
  });

  test('same-origin POST (Origin exactly matches this server\'s own address) is never rejected', async () => {
    const res = await request(server)
      .post('/api/v1/sync/cache/flush')
      .set('Origin', `http://127.0.0.1:${port}`)
      .send({});
    expect(res.status).not.toBe(403);
    expect(res.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${port}`);
  });

  test('same-origin PATCH is never rejected (not just GET/POST)', async () => {
    const res = await request(server)
      .patch('/api/v1/accounts/00000000-0000-0000-0000-000000000000')
      .set('Origin', `http://127.0.0.1:${port}`)
      .send({ status: 'active' });
    expect(res.status).not.toBe(403); // 404 (unknown account) is fine -- 403 is the bug this guards against
  });

  test('localhost origin is allowed when the request itself arrived via localhost, with zero hardcoding', async () => {
    const res = await request(`http://localhost:${port}`)
      .post('/api/v1/sync/cache/flush')
      .set('Origin', `http://localhost:${port}`)
      .send({});
    expect(res.status).not.toBe(403);
  });

  test('a request with no Origin header at all is allowed (curl, server-to-server, simple same-origin GET)', async () => {
    const res = await request(server).post('/api/v1/sync/cache/flush').send({});
    expect(res.status).not.toBe(403);
  });

  test('a genuinely foreign/invalid origin is still rejected with 403 -- CORS is not weakened', async () => {
    const res = await request(server)
      .post('/api/v1/sync/cache/flush')
      .set('Origin', 'https://evil.example.com')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Origin not allowed');
  });

  test('an origin one port off from this server\'s own is still a different origin and is rejected', async () => {
    const res = await request(server)
      .post('/api/v1/sync/cache/flush')
      .set('Origin', `http://127.0.0.1:${port + 1}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('a CORS preflight OPTIONS request for a same-origin call succeeds with the right headers', async () => {
    const res = await request(server)
      .options('/api/v1/accounts')
      .set('Origin', `http://127.0.0.1:${port}`)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${port}`);
    expect(res.headers['access-control-allow-methods']).toBeDefined();
  });

  test('a CORS preflight OPTIONS request for a foreign origin is rejected', async () => {
    const res = await request(server)
      .options('/api/v1/accounts')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Origin not allowed');
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
