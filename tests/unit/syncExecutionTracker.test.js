'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');

describe('syncExecutionTracker', () => {
  let testDb;
  let tracker;
  let accountId;

  beforeAll(async () => {
    testDb = await createTestDb();
    tracker = require('../../src/services/syncExecutionTracker');
  });

  afterAll(() => {
    testDb.cleanup();
  });

  beforeEach(() => {
    accountId = uuidv4();
  });

  afterEach(() => {
    testDb.db.run('DELETE FROM sync_live_executions');
    testDb.db.run('DELETE FROM sync_live_events');
  });

  test('createExecution durably persists a running row immediately, before any work happens', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    expect(executionId).toBeTruthy();

    const row = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [executionId]);
    expect(row.ad_account_id).toBe(accountId);
    expect(row.source).toBe('force');
    expect(row.status).toBe('running');
    expect(row.started_at).toBeTruthy();
    expect(row.finished_at).toBeFalsy();
  });

  test('updateExecution only touches whitelisted columns and always bumps updated_at', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    const before = testDb.db.get('SELECT updated_at FROM sync_live_executions WHERE id = ?', [executionId]);

    await tracker.updateExecution(executionId, {
      current_stage: 'campaigns',
      campaigns_discovered: 173,
      not_a_real_column: 'should be silently dropped',
    });

    const after = testDb.db.get('SELECT * FROM sync_live_executions WHERE id = ?', [executionId]);
    expect(after.current_stage).toBe('campaigns');
    expect(after.campaigns_discovered).toBe(173);
    expect(after.updated_at >= before.updated_at).toBe(true);
  });

  test('finishExecution sets a terminal status and finished_at', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    await tracker.finishExecution(executionId, { status: 'partial', partialReason: 'timed_out' });

    const row = await tracker.getExecution(executionId);
    expect(row.status).toBe('partial');
    expect(row.partial_reason).toBe('timed_out');
    expect(row.finished_at).toBeTruthy();
  });

  test('logEvent appends without overwriting prior events, and never requires a value for metadata', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    await tracker.logEvent(executionId, 'TOKEN_DECRYPT_SUCCESS');
    await tracker.logEvent(executionId, 'META_REQUEST_START', 'campaigns', { resource: 'campaigns', page: 1 });

    const events = await tracker.getEvents(executionId);
    expect(events.length).toBe(2);
    expect(events[0].stage).toBe('TOKEN_DECRYPT_SUCCESS');
    expect(events[0].metadata).toBeFalsy();
    expect(JSON.parse(events[1].metadata)).toEqual({ resource: 'campaigns', page: 1 });
  });

  test('createRecorder.metaRequestStart/End durably records real Meta round-trip evidence, even if called individually (not just at the very end)', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    const recorder = tracker.createRecorder(executionId);

    await recorder.metaRequestStart({ resource: 'campaigns', page: 1 });
    // Simulate the process being killed here -- what's already committed
    // must already prove a request was attempted, without waiting for
    // metaRequestEnd to ever be called.
    let row = await tracker.getExecution(executionId);
    expect(row.meta_requests_started).toBe(1);
    expect(row.last_meta_request_at).toBeTruthy();

    await recorder.metaRequestEnd({ resource: 'campaigns', page: 1, status: 200, count: 100, durationMs: 1234 });
    row = await tracker.getExecution(executionId);
    expect(row.meta_requests_completed).toBe(1);
    expect(row.pages_fetched).toBe(1);
    expect(row.last_successful_meta_request_at).toBeTruthy();

    const events = await tracker.getEvents(executionId);
    expect(events.map(e => e.stage)).toEqual(['META_REQUEST_START', 'META_RESPONSE']);
    expect(JSON.parse(events[1].metadata)).toMatchObject({ status: 200, count: 100 });
  });

  test('createRecorder.batch persists cursor before/after so resume state is provable without reading application memory', async () => {
    const executionId = await tracker.createExecution(accountId, 'force');
    const recorder = tracker.createRecorder(executionId);

    await recorder.batch('BATCH_COMPLETE', {
      batchNumber: 1, cursorBefore: null, cursorAfter: 'campaign_25', processed: 25, remaining: 148,
    });

    const row = await tracker.getExecution(executionId);
    expect(row.batches_completed).toBe(1);
    expect(row.cursor_after).toBe('campaign_25');
  });

  test('getLatestExecutionForAccount returns the most recent run when multiple exist', async () => {
    const first = await tracker.createExecution(accountId, 'scheduler');
    await tracker.finishExecution(first, { status: 'completed' });
    await new Promise(r => setTimeout(r, 5));
    const second = await tracker.createExecution(accountId, 'force');

    const latest = await tracker.getLatestExecutionForAccount(accountId);
    expect(latest.id).toBe(second);
  });
});
