/**
 * Approval Workflow Service — Phase 28
 *
 * Manages approval requests for campaigns, creatives, budgets, recommendations.
 * Enforces workflow rules and audit trails.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Create approval request
 */
function createApprovalRequest(workspaceId, approvalData) {
  const approvalId = generateId('apr');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO approvals (
      id, workspace_id, entity_type, entity_id,
      requested_by_user_id, approval_level, assigned_to_user_id,
      status, reason, order_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    approvalId,
    workspaceId,
    approvalData.entity_type,
    approvalData.entity_id,
    approvalData.requested_by_user_id,
    approvalData.approval_level || 'manager',
    approvalData.assigned_to_user_id || null,
    'pending',
    approvalData.reason || null,
    approvalData.order_index || 0,
    now,
    now,
  ]);

  return getApproval(approvalId);
}

/**
 * Get approval request
 */
function getApproval(approvalId) {
  return db.get(`
    SELECT * FROM approvals WHERE id = ?
  `, [approvalId]);
}

/**
 * List pending approvals
 */
function listPendingApprovals(workspaceId, filters = {}) {
  let query = `
    SELECT a.* FROM approvals a
    WHERE a.workspace_id = ? AND a.status IN ('pending', 'revisions_requested')
  `;
  const params = [workspaceId];

  if (filters.assigned_to_user_id) {
    query += ' AND a.assigned_to_user_id = ?';
    params.push(filters.assigned_to_user_id);
  }

  if (filters.entity_type) {
    query += ' AND a.entity_type = ?';
    params.push(filters.entity_type);
  }

  if (filters.approval_level) {
    query += ' AND a.approval_level = ?';
    params.push(filters.approval_level);
  }

  query += ' ORDER BY a.created_at ASC';

  return db.all(query, params);
}

/**
 * Approve request
 */
function approveRequest(approvalId, userId, feedback) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE approvals
    SET status = 'approved', feedback = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ?
    WHERE id = ?
  `, [feedback || null, userId, now, now, approvalId]);

  return getApproval(approvalId);
}

/**
 * Reject request
 */
function rejectRequest(approvalId, userId, feedback) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE approvals
    SET status = 'rejected', feedback = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ?
    WHERE id = ?
  `, [feedback || null, userId, now, now, approvalId]);

  return getApproval(approvalId);
}

/**
 * Request revisions
 */
function requestRevisions(approvalId, userId, feedback) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE approvals
    SET status = 'revisions_requested', feedback = ?, updated_at = ?
    WHERE id = ?
  `, [feedback || null, now, approvalId]);

  return getApproval(approvalId);
}

/**
 * Get approval chain for entity
 */
function getApprovalChain(entityType, entityId) {
  return db.all(`
    SELECT * FROM approvals
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY order_index, created_at
  `, [entityType, entityId]);
}

/**
 * Check if all approvals are complete
 */
function isApprovedByAllLevels(entityType, entityId, requiredLevels) {
  const chain = getApprovalChain(entityType, entityId);
  if (!chain || chain.length === 0) return false;

  for (const level of requiredLevels) {
    const approval = chain.find(a => a.approval_level === level);
    if (!approval || approval.status !== 'approved') {
      return false;
    }
  }

  return true;
}

/**
 * Get approval stats for workspace
 */
function getApprovalStats(workspaceId) {
  const stats = {
    pending: db.get(
      'SELECT COUNT(*) as count FROM approvals WHERE workspace_id = ? AND status = "pending"',
      [workspaceId]
    )?.count || 0,
    approved: db.get(
      'SELECT COUNT(*) as count FROM approvals WHERE workspace_id = ? AND status = "approved"',
      [workspaceId]
    )?.count || 0,
    rejected: db.get(
      'SELECT COUNT(*) as count FROM approvals WHERE workspace_id = ? AND status = "rejected"',
      [workspaceId]
    )?.count || 0,
    revisions_requested: db.get(
      'SELECT COUNT(*) as count FROM approvals WHERE workspace_id = ? AND status = "revisions_requested"',
      [workspaceId]
    )?.count || 0,
  };

  const byType = db.all(`
    SELECT entity_type, status, COUNT(*) as count
    FROM approvals
    WHERE workspace_id = ?
    GROUP BY entity_type, status
  `, [workspaceId]);

  return { ...stats, by_type: byType };
}

module.exports = {
  createApprovalRequest,
  getApproval,
  listPendingApprovals,
  approveRequest,
  rejectRequest,
  requestRevisions,
  getApprovalChain,
  isApprovedByAllLevels,
  getApprovalStats,
};
