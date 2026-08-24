/**
 * Sync Execution Tracker
 *
 * Durable, DB-committed observability for one runDueForAccount() invocation
 * (schema.phase34.js). Every write here happens immediately, in its own
 * statement -- not batched in memory -- so a hard Vercel platform timeout
 * (which can kill the process before buffered console output is flushed)
 * still leaves a true record of how far execution actually got. This is
 * additive, read-mostly-for-observability infrastructure: it never gates
 * or alters sync behavior, only records it.
 *
 * Never pass secret values (tokens, keys, cookies) into metadata -- this
 * module does not redact, callers are responsible for only passing safe
 * fields (resource paths, counts, statuses, durations).
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const UPDATABLE_FIELDS = [
  'status', 'current_stage', 'current_operation',
  'campaigns_discovered', 'campaigns_processed', 'ad_sets_processed', 'ads_processed',
  'pages_fetched', 'batches_completed',
  'meta_requests_started', 'meta_requests_completed',
  'last_meta_request_at', 'last_successful_meta_request_at', 'last_db_write_at',
  'cursor_before', 'cursor_after', 'partial_reason', 'error_code', 'error_message',
];

/** Creates the execution row immediately (status='running') -- before decryptToken() or any tier runs. */
async function createExecution(adAccountId, source) {
  const id = uuidv4();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO sync_live_executions (id, ad_account_id, source, status, started_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [id, adAccountId, source, now, now]
  );
  return id;
}

/** Partial update -- only whitelisted columns, always bumps updated_at. Safe to call frequently. */
async function updateExecution(executionId, patch) {
  const keys = Object.keys(patch).filter(k => UPDATABLE_FIELDS.includes(k));
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => patch[k]);
  await db.run(
    `UPDATE sync_live_executions SET ${setClause}, updated_at = ? WHERE id = ?`,
    [...values, new Date().toISOString(), executionId]
  );
}

/** Terminal write -- one of completed/partial/failed/timed_out. */
async function finishExecution(executionId, { status, partialReason = null, errorCode = null, errorMessage = null, ...counts }) {
  const now = new Date().toISOString();
  await updateExecution(executionId, { ...counts, status, partial_reason: partialReason, error_code: errorCode, error_message: errorMessage });
  await db.run(`UPDATE sync_live_executions SET finished_at = ? WHERE id = ?`, [now, executionId]);
}

/** Append-only timeline event. metadata must be a plain JSON-serializable object with no secrets. */
async function logEvent(executionId, stage, message = null, metadata = null) {
  await db.run(
    `INSERT INTO sync_live_events (id, execution_id, ts, stage, message, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), executionId, new Date().toISOString(), stage, message, metadata ? JSON.stringify(metadata) : null]
  );
}

async function getExecution(executionId) {
  return db.get(`SELECT * FROM sync_live_executions WHERE id = ?`, [executionId]);
}

async function getEvents(executionId, limit = 200) {
  return db.all(`SELECT * FROM sync_live_events WHERE execution_id = ? ORDER BY ts ASC LIMIT ?`, [executionId, limit]);
}

async function getLatestExecutionForAccount(adAccountId) {
  return db.get(
    `SELECT * FROM sync_live_executions WHERE ad_account_id = ? ORDER BY started_at DESC LIMIT 1`,
    [adAccountId]
  );
}

/**
 * Builds a recorder bound to one executionId, for passing into
 * metaApiClient (metaGet/metaGetAll) and the sync engine tiers. Increments
 * counters via updateExecution and appends a timeline event per call --
 * deliberately synchronous/awaited at each call site so a mid-request kill
 * still leaves whatever happened before it durably recorded.
 */
function createRecorder(executionId) {
  let metaRequestsStarted = 0;
  let metaRequestsCompleted = 0;
  let pagesFetched = 0;

  return {
    executionId,

    async stage(name, operation = null) {
      await updateExecution(executionId, { current_stage: name, current_operation: operation });
      await logEvent(executionId, name.toUpperCase(), operation);
    },

    async metaRequestStart({ resource, page = null }) {
      metaRequestsStarted++;
      const now = new Date().toISOString();
      await updateExecution(executionId, { meta_requests_started: metaRequestsStarted, last_meta_request_at: now });
      await logEvent(executionId, 'META_REQUEST_START', resource, { resource, page });
    },

    async metaRequestEnd({ resource, page = null, status, count = null, durationMs = null, error = null }) {
      metaRequestsCompleted++;
      if (page !== null) pagesFetched++;
      const now = new Date().toISOString();
      const patch = { meta_requests_completed: metaRequestsCompleted };
      if (pagesFetched > 0) patch.pages_fetched = pagesFetched;
      if (!error) patch.last_successful_meta_request_at = now;
      await updateExecution(executionId, patch);
      await logEvent(executionId, error ? 'META_REQUEST_ERROR' : 'META_RESPONSE', resource, {
        resource, page, status, count, durationMs, error: error || undefined,
      });
    },

    /** Generic progress counter update (campaigns_discovered/processed, ad_sets_processed, ads_processed). No event row -- high-frequency, counters only. */
    async progress(patch) {
      await updateExecution(executionId, patch);
    },

    async dbWrite(label, counts = {}) {
      await updateExecution(executionId, { last_db_write_at: new Date().toISOString() });
      await logEvent(executionId, 'DB_WRITE', label, counts);
    },

    /** Generic durable checkpoint event -- for tiers (e.g. insights) whose resume unit isn't the campaign-tree batch shape. */
    async checkpoint(stage, { cursorBefore = null, cursorAfter = null, processed = null, remaining = null } = {}) {
      await updateExecution(executionId, { cursor_before: cursorBefore, cursor_after: cursorAfter });
      await logEvent(executionId, 'CHECKPOINT_PERSISTED', stage, { cursorBefore, cursorAfter, processed, remaining });
    },

    async batch(label, { batchNumber, cursorBefore, cursorAfter, processed, remaining }) {
      await updateExecution(executionId, {
        batches_completed: batchNumber,
        cursor_before: cursorBefore ?? null,
        cursor_after: cursorAfter ?? null,
      });
      await logEvent(executionId, label, `batch ${batchNumber}`, { batchNumber, cursorBefore, cursorAfter, processed, remaining });
    },
  };
}

module.exports = {
  createExecution, updateExecution, finishExecution, logEvent,
  getExecution, getEvents, getLatestExecutionForAccount, createRecorder,
};
