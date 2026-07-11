/**
 * Workspace Service — Phase 28
 *
 * Manages workspace creation, member management, isolation,
 * and workspace-scoped operations.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Create a new workspace
 */
function createWorkspace(userId, workspaceData) {
  const workspaceId = generateId('ws');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO workspaces (
      id, owner_user_id, workspace_type, name, logo_url,
      industry, country, currency, timezone, billing_email,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    workspaceId,
    userId,
    workspaceData.workspace_type || 'agency',
    workspaceData.name,
    workspaceData.logo_url || null,
    workspaceData.industry || null,
    workspaceData.country || null,
    workspaceData.currency || 'USD',
    workspaceData.timezone || 'UTC',
    workspaceData.billing_email || null,
    'active',
    now,
    now,
  ]);

  // Add owner as workspace member
  const memberId = generateId('wsm');
  db.run(`
    INSERT INTO workspace_members (
      id, workspace_id, user_id, role, status, joined_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [memberId, workspaceId, userId, 'owner', 'active', now, now, now]);

  return getWorkspace(workspaceId);
}

/**
 * Get workspace details
 */
function getWorkspace(workspaceId) {
  return db.get(`
    SELECT * FROM workspaces WHERE id = ?
  `, [workspaceId]);
}

/**
 * List user's workspaces
 */
function getUserWorkspaces(userId) {
  return db.all(`
    SELECT w.* FROM workspaces w
    INNER JOIN workspace_members wm ON w.id = wm.workspace_id
    WHERE wm.user_id = ? AND wm.status = 'active'
    ORDER BY w.updated_at DESC
  `, [userId]);
}

/**
 * Add member to workspace
 */
function addWorkspaceMember(workspaceId, userId, role) {
  const memberId = generateId('wsm');
  const now = new Date().toISOString();

  const existing = db.get(
    'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId]
  );

  if (existing) {
    return {
      error: 'User already in workspace',
      member_id: existing.id,
    };
  }

  db.run(`
    INSERT INTO workspace_members (
      id, workspace_id, user_id, role, status, invited_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [memberId, workspaceId, userId, role || 'viewer', 'active', now, now, now]);

  return {
    id: memberId,
    workspace_id: workspaceId,
    user_id: userId,
    role: role || 'viewer',
    status: 'active',
  };
}

/**
 * Get workspace members
 */
function getWorkspaceMembers(workspaceId) {
  return db.all(`
    SELECT wm.*, u.email, cr.name as custom_role_name
    FROM workspace_members wm
    LEFT JOIN users u ON wm.user_id = u.id
    LEFT JOIN custom_roles cr ON wm.custom_role_id = cr.id
    WHERE wm.workspace_id = ? AND wm.status = 'active'
    ORDER BY wm.role DESC, u.email ASC
  `, [workspaceId]);
}

/**
 * Update member role
 */
function updateMemberRole(workspaceId, userId, newRole) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE workspace_members
    SET role = ?, updated_at = ?
    WHERE workspace_id = ? AND user_id = ?
  `, [newRole, now, workspaceId, userId]);

  return db.get(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId]
  );
}

/**
 * Remove member from workspace
 */
function removeWorkspaceMember(workspaceId, userId) {
  const now = new Date().toISOString();

  db.run(`
    UPDATE workspace_members
    SET status = 'suspended', updated_at = ?
    WHERE workspace_id = ? AND user_id = ?
  `, [now, workspaceId, userId]);

  return { success: true };
}

/**
 * Get member permissions for workspace
 */
function getMemberPermissions(workspaceId, userId) {
  const member = db.get(
    'SELECT role, custom_role_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId]
  );

  if (!member) {
    return { permissions: [] };
  }

  // Get permissions based on role
  const rolePermissions = {
    owner: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'invite', 'manage_users', 'manage_billing', 'manage_accounts'],
    agency_admin: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'invite', 'manage_users'],
    manager: ['view', 'create', 'edit', 'approve', 'export', 'invite'],
    media_buyer: ['view', 'create', 'edit', 'export'],
    designer: ['view', 'create', 'edit'],
    copywriter: ['view', 'create', 'edit'],
    analyst: ['view', 'export'],
    sales: ['view', 'export'],
    support: ['view'],
    client: ['view'],
    viewer: ['view'],
  };

  let permissions = rolePermissions[member.role] || [];

  // If custom role, merge custom permissions
  if (member.custom_role_id) {
    const customRole = db.get(
      'SELECT permissions_json FROM custom_roles WHERE id = ?',
      [member.custom_role_id]
    );
    if (customRole && customRole.permissions_json) {
      const customPerms = JSON.parse(customRole.permissions_json);
      permissions = [...new Set([...permissions, ...customPerms])];
    }
  }

  return { permissions };
}

/**
 * Check if user can perform action
 */
function canUserPerform(workspaceId, userId, action) {
  const perms = getMemberPermissions(workspaceId, userId);
  return perms.permissions.includes(action);
}

/**
 * Create custom role
 */
function createCustomRole(workspaceId, roleData) {
  const roleId = generateId('cr');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO custom_roles (
      id, workspace_id, name, description, permissions_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    roleId,
    workspaceId,
    roleData.name,
    roleData.description || null,
    JSON.stringify(roleData.permissions || []),
    now,
    now,
  ]);

  return db.get('SELECT * FROM custom_roles WHERE id = ?', [roleId]);
}

/**
 * Get workspace analytics
 */
function getWorkspaceAnalytics(workspaceId) {
  const memberCount = db.get(
    'SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ? AND status = "active"',
    [workspaceId]
  );

  const projectCount = db.get(
    'SELECT COUNT(*) as count FROM projects WHERE workspace_id = ?',
    [workspaceId]
  );

  const taskCount = db.get(`
    SELECT COUNT(*) as count FROM project_tasks
    WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)
  `, [workspaceId]);

  const pendingApprovals = db.get(`
    SELECT COUNT(*) as count FROM approvals
    WHERE workspace_id = ? AND status IN ('pending', 'revisions_requested')
  `, [workspaceId]);

  return {
    member_count: memberCount?.count || 0,
    project_count: projectCount?.count || 0,
    task_count: taskCount?.count || 0,
    pending_approvals: pendingApprovals?.count || 0,
  };
}

module.exports = {
  createWorkspace,
  getWorkspace,
  getUserWorkspaces,
  addWorkspaceMember,
  getWorkspaceMembers,
  updateMemberRole,
  removeWorkspaceMember,
  getMemberPermissions,
  canUserPerform,
  createCustomRole,
  getWorkspaceAnalytics,
};
