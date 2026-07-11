/**
 * Billing Service — Phase 29
 *
 * Billing, invoicing, payment tracking, and refunds.
 * Architecture ready for Stripe, PayPal, Paddle, Lemon Squeezy integration.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ─────────────────────────────────────────────
// INVOICE GENERATION
// ─────────────────────────────────────────────

/**
 * Create invoice for tenant
 */
function createInvoice(tenantId, invoiceData) {
  const invoiceId = generateId('inv');
  const invoiceNumber = generateInvoiceNumber();
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO billing_history (
      id, tenant_id, invoice_number, subscription_id, amount_cents,
      currency, billing_reason, status, payment_method, description,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    invoiceId,
    tenantId,
    invoiceNumber,
    invoiceData.subscription_id || null,
    invoiceData.amount_cents,
    invoiceData.currency || 'USD',
    invoiceData.billing_reason || 'subscription_cycle',
    'pending',
    invoiceData.payment_method || null,
    invoiceData.description || null,
    now,
    now,
  ]);

  return getInvoice(invoiceId);
}

/**
 * Get invoice
 */
function getInvoice(invoiceId) {
  return db.get(`
    SELECT * FROM billing_history WHERE id = ?
  `, [invoiceId]);
}

/**
 * List invoices for tenant
 */
function listInvoices(tenantId, filters = {}) {
  let query = 'SELECT * FROM billing_history WHERE tenant_id = ?';
  const params = [tenantId];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY created_at DESC';

  return db.all(query, params);
}

/**
 * Mark invoice as paid
 */
function markInvoicePaid(invoiceId, paymentMethod = 'unknown') {
  const now = new Date().toISOString();

  db.run(`
    UPDATE billing_history
    SET status = 'paid', payment_method = ?, payment_date = ?, updated_at = ?
    WHERE id = ?
  `, [paymentMethod, now, now, invoiceId]);

  return getInvoice(invoiceId);
}

/**
 * Mark invoice as failed
 */
function markInvoiceFailed(invoiceId, reason = null) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE billing_history
    SET status = 'failed', updated_at = ?
    WHERE id = ?
  `, [now, invoiceId]);

  return getInvoice(invoiceId);
}

// ─────────────────────────────────────────────
// REFUNDS
// ─────────────────────────────────────────────

/**
 * Process refund for invoice
 */
function processRefund(invoiceId, reason = null) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE billing_history
    SET status = 'refunded', refund_date = ?, refund_reason = ?, updated_at = ?
    WHERE id = ?
  `, [now, reason, now, invoiceId]);

  return getInvoice(invoiceId);
}

/**
 * Get refunds for tenant
 */
function getRefundsForTenant(tenantId) {
  return db.all(`
    SELECT * FROM billing_history
    WHERE tenant_id = ? AND status = 'refunded'
    ORDER BY refund_date DESC
  `, [tenantId]);
}

// ─────────────────────────────────────────────
// BILLING HISTORY & ANALYTICS
// ─────────────────────────────────────────────

/**
 * Get billing summary for tenant
 */
function getBillingSummary(tenantId) {
  const invoices = db.all(
    'SELECT * FROM billing_history WHERE tenant_id = ?',
    [tenantId]
  );

  const totalInvoiced = invoices
    .filter(i => i.status === 'paid')
    .reduce((sum, i) => sum + (i.amount_cents || 0), 0);

  const totalPending = invoices
    .filter(i => i.status === 'pending')
    .reduce((sum, i) => sum + (i.amount_cents || 0), 0);

  const totalRefunded = invoices
    .filter(i => i.status === 'refunded')
    .reduce((sum, i) => sum + (i.amount_cents || 0), 0);

  return {
    total_invoiced: totalInvoiced / 100, // Convert cents to dollars
    total_pending: totalPending / 100,
    total_refunded: totalRefunded / 100,
    invoice_count: invoices.length,
    paid_invoices: invoices.filter(i => i.status === 'paid').length,
    pending_invoices: invoices.filter(i => i.status === 'pending').length,
    failed_invoices: invoices.filter(i => i.status === 'failed').length,
  };
}

/**
 * Get MRR (Monthly Recurring Revenue)
 */
function calculateMRR() {
  const mrr = db.get(`
    SELECT SUM(sp.price_monthly) as total
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.status = 'active' AND ts.billing_cycle = 'monthly'
  `)?.total || 0;

  return mrr;
}

/**
 * Get ARR (Annual Recurring Revenue)
 */
function calculateARR() {
  const yearly = db.get(`
    SELECT SUM(sp.price_yearly) as total
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.status = 'active' AND ts.billing_cycle = 'yearly'
  `)?.total || 0;

  const monthly = db.get(`
    SELECT SUM(sp.price_monthly * 12) as total
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.status = 'active' AND ts.billing_cycle = 'monthly'
  `)?.total || 0;

  return yearly + monthly;
}

/**
 * Get churn rate
 */
function getChurnRate(monthsBack = 1) {
  const currentMonth = new Date();
  currentMonth.setMonth(currentMonth.getMonth() - monthsBack);
  const month = currentMonth.toISOString().slice(0, 7);

  const cancelled = db.get(`
    SELECT COUNT(*) as count FROM tenant_subscriptions
    WHERE status = 'cancelled' AND date(cancelled_at) >= ?
  `, [month]
  )?.count || 0;

  const active = db.get(
    'SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = "active"'
  )?.count || 1;

  return (cancelled / active) * 100;
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function generateInvoiceNumber() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `INV-${year}${month}-${random}`;
}

/**
 * Schedule subscription renewal
 */
function scheduleSubscriptionRenewal(tenantId, daysFromNow = 1) {
  const jobId = generateId('job');
  const now = new Date().toISOString();
  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + daysFromNow);

  db.run(`
    INSERT INTO background_jobs (
      id, tenant_id, job_type, status, scheduled_for, priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    jobId,
    tenantId,
    'send_invoice',
    'pending',
    scheduledFor.toISOString(),
    'high',
    now,
    now,
  ]);

  return { job_id: jobId };
}

module.exports = {
  createInvoice,
  getInvoice,
  listInvoices,
  markInvoicePaid,
  markInvoiceFailed,
  processRefund,
  getRefundsForTenant,
  getBillingSummary,
  calculateMRR,
  calculateARR,
  getChurnRate,
  generateInvoiceNumber,
  scheduleSubscriptionRenewal,
};
