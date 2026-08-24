'use strict';

/**
 * Real end-to-end coverage of POST /auth/login, POST /auth/logout, and
 * GET /auth/status -- against the actual Express app (createApp()), the
 * real checkCredentials()/statelessAuth cookie code, not mocks. This gap
 * existed before this mission (no prior test file touched /auth/login at
 * all -- confirmed via repo-wide grep) despite every other API test
 * relying on requireAuth's isTest bypass (src/middleware/auth.js) to reach
 * protected routes without ever exercising real login. The /auth/* routes
 * are mounted BEFORE requireAuth in app.js specifically so login/logout/
 * status stay reachable unauthenticated -- which also means the isTest
 * bypass does NOT apply to them, so this test genuinely exercises the real
 * credential-check and cookie-signing code paths, in-process.
 */

const request = require('supertest');
const { createTestDb } = require('../helpers/testDb');
const { createApp } = require('../../src/app');

describe('API: /api/v1/auth', () => {
  let testDb;
  let app;
  const REAL_EMAIL = 'qa-test@example.com';
  const REAL_PASSWORD = 'a-strong-test-only-password-987!';
  let originalEmail, originalPassword;

  beforeAll(async () => {
    testDb = await createTestDb();
    originalEmail = process.env.USER_EMAIL;
    originalPassword = process.env.USER_PASSWORD;
    process.env.USER_EMAIL = REAL_EMAIL;
    process.env.USER_PASSWORD = REAL_PASSWORD;
    app = createApp();
  });

  afterAll(() => {
    testDb.cleanup();
    if (originalEmail === undefined) delete process.env.USER_EMAIL; else process.env.USER_EMAIL = originalEmail;
    if (originalPassword === undefined) delete process.env.USER_PASSWORD; else process.env.USER_PASSWORD = originalPassword;
  });

  test('GET /auth/status is unauthenticated before any login', async () => {
    const res = await request(app).get('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  test('POST /auth/login with wrong credentials returns 401 and does not set a cookie', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'wrong@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('POST /auth/login with the correct credentials succeeds and sets a signed httpOnly cookie', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: REAL_EMAIL, password: REAL_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.some(c => c.startsWith('sid='))).toBe(true);
    expect(cookies.some(c => /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some(c => /SameSite=Lax/i.test(c))).toBe(true);
  });

  test('the cookie issued by a successful login makes GET /auth/status report authenticated:true', async () => {
    const agent = request.agent(app); // supertest agent persists cookies across requests, like a real browser
    await agent.post('/api/v1/auth/login').send({ email: REAL_EMAIL, password: REAL_PASSWORD });
    const res = await agent.get('/api/v1/auth/status');
    expect(res.body).toEqual({ authenticated: true });
  });

  test('POST /auth/logout clears the cookie and subsequent status reports authenticated:false', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: REAL_EMAIL, password: REAL_PASSWORD });
    expect((await agent.get('/api/v1/auth/status')).body.authenticated).toBe(true);

    const logoutRes = await agent.post('/api/v1/auth/logout');
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toEqual({ authenticated: false });

    const statusAfter = await agent.get('/api/v1/auth/status');
    expect(statusAfter.body.authenticated).toBe(false);
  });

  test('login is case-sensitive and rejects a correct password with the wrong email', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'someone-else@example.com', password: REAL_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('an empty/missing body is rejected, not a 500', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(401);
  });
});
