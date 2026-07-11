/**
 * Collaboration Service — Phase 28
 *
 * Manages comments, activity timeline, notifications, audit logging.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ──────────────────────────────────
// COMMENTS
// ──────────────────────────────────

/**
 * Add comment to entity
 */
function addComment(entityType, entityId, userId, content, mentions = []) {
  const commentId = generateId('com');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO comments (
      id, entity_type, entity_id, user_id, content,
      mentions_json, is_pinned, is_resolved, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    commentId,
    entityType,
    entityId,
    userId,
    content,
    JSON.stringify(mentions),
    0,
    0,
    now,
    now,
  ]);

  return getComment(commentId);
}

/**
 * Get comment
 */
function getComment(commentId) {
  const comment = db.get(`
    SELECT c.*, u.email as user_email FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `, [commentId]);

  if (!comment) return null;

  const replies = db.all(`
    SELECT c.*, u.email as user_email FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.parent_comment_id = ?
    ORDER BY c.created_at ASC
  `, [commentId]);

  return {
    ...comment,
    mentions: comment.mentions_json ? JSON.parse(comment.mentions_json) : [],
    reactions: comment.reactions_json ? JSON.parse(comment.reactions_json) : [],
    replies: replies || [],
  };
}

/**
 * List comments on entity
 */
function listComments(entityType, entityId, includeReplies = true) {
  const comments = db.all(`
    SELECT c.*, u.email as user_email FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.entity_type = ? AND c.entity_id = ? AND c.parent_comment_id IS NULL
    ORDER BY c.created_at DESC
  `, [entityType, entityId]);

  if (!includeReplies) return comments;

  return comments.map(c => getComment(c.id));
}

/**
 * Update comment
 */
function updateComment(commentId, content) {
  const now = new Date().toISOString();

  db.run(
    'UPDATE comments SET content = ?, updated_at = ? WHERE id = ?',
    [content, now, commentId]
  );

  return getComment(commentId);
}

/**
 * Delete comment (soft delete)
 */
function deleteComment(commentId) {
  // Mark as deleted by clearing content
  const now = new Date().toISOString();
  db.run(
    'UPDATE comments SET content = "[deleted]", updated_at = ? WHERE id = ?',
    [now, commentId]
  );
  return { success: true };
}

/**
 * Pin/unpin comment
 */
function togglePinComment(commentId) {
  const comment = db.get('SELECT is_pinned FROM comments WHERE id = ?', [commentId]);
  if (!comment) return null;

  const now = new Date().toISOString();
  db.run(
    'UPDATE comments SET is_pinned = ?, updated_at = ? WHERE id = ?',
    [1 - comment.is_pinned, now, commentId]
  );

  return getComment(commentId);
}

/**
 * Add emoji reaction to comment
 */
function addReaction(commentId, userId, emoji) {
  const comment = db.get('SELECT reactions_json FROM comments WHERE id = ?', [commentId]);
  if (!comment) return null;

  const reactions = comment.reactions_json ? JSON.parse(comment.reactions_json) : {};
  if (!reactions[emoji]) reactions[emoji] = [];

  if (!reactions[emoji].includes(userId)) {
    reactions[emoji].push(userId);
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE comments SET reactions_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(reactions), now, commentId]
  );

  return getComment(commentId);
}

/**
 * Resolve comment thread
 */
function resolveComment(commentId) {
  const now = new Date().toISOString();
  db.run(
    'UPDATE comments SET is_resolved = 1, resolved_at = ?, updated_at = ? WHERE id = ?',
    [now, now, commentId]
  );

  return getComment(commentId);
}

// ──────────────────────────────────
// ACTIVITY TIMELINE
// ──────────────────────────────────

/**
 * Log activity to timeline
 */
function logActivity(workspaceId, userId, actionType, details = {}) {
  const activityId = generateId('act');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO activity_timeline (
      id, workspace_id, user_id, action_type, entity_type, entity_id,
      old_value, new_value, description, ip_address, user_agent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    activityId,
    workspaceId,
    userId,
    actionType,
    details.entity_type || null,
    details.entity_id || null,
    details.old_value || null,
    details.new_value || null,
    details.description || null,
    details.ip_address || null,
    details.user_agent || null,
    now,
  ]);

  return db.get('SELECT * FROM activity_timeline WHERE id = ?', [activityId]);
}

/**
 * Get activity timeline
 */
function getActivityTimeline(workspaceId, filters = {}) {
  let query = `
    SELECT a.*, u.email as user_email FROM activity_timeline a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.workspace_id = ?
  `;
  const params = [workspaceId];

  if (filters.user_id) {
    query += ' AND a.user_id = ?';
    params.push(filters.user_id);
  }

  if (filters.action_type) {
    query += ' AND a.action_type = ?';
    params.push(filters.action_type);
  }

  if (filters.entity_type) {
    query += ' AND a.entity_type = ?';
    params.push(filters.entity_type);
  }

  if (filters.entity_id) {
    query += ' AND a.entity_id = ?';
    params.push(filters.entity_id);
  }

  query += ' ORDER BY a.created_at DESC LIMIT 500';

  return db.all(query, params);
}

// ──────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────

/**
 * Create notification
 */
function createNotification(workspaceId, userId, notificationData) {
  const notificationId = generateId('ntf');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO notifications (
      id, workspace_id, user_id, triggered_by_user_id, notification_type,
      entity_type, entity_id, title, message, action_url,
      is_read, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    notificationId,
    workspaceId,
    userId,
    notificationData.triggered_by_user_id || null,
    notificationData.notification_type,
    notificationData.entity_type || null,
    notificationData.entity_id || null,
    notificationData.title,
    notificationData.message || null,
    notificationData.action_url || null,
    0,
    now,
  ]);

  return getNotification(notificationId);
}

/**
 * Get notification
 */
function getNotification(notificationId) {
  return db.get(`
    SELECT * FROM notifications WHERE id = ?
  `, [notificationId]);
}

/**
 * List user notifications
 */
function listNotifications(workspaceId, userId, filters = {}) {
  let query = `
    SELECT * FROM notifications
    WHERE workspace_id = ? AND user_id = ?
  `;
  const params = [workspaceId, userId];

  if (filters.unread_only) {
    query += ' AND is_read = 0';
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  return db.all(query, params);
}

/**
 * Mark notification as read
 */
function markNotificationRead(notificationId) {
  const now = new Date().toISOString();
  db.run(
    'UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?',
    [now, notificationId]
  );
  return getNotification(notificationId);
}

/**
 * Mark all notifications as read
 */
function markAllNotificationsRead(workspaceId, userId) {
  const now = new Date().toISOString();
  db.run(
    'UPDATE notifications SET is_read = 1, read_at = ? WHERE workspace_id = ? AND user_id = ? AND is_read = 0',
    [now, workspaceId, userId]
  );
  return { success: true };
}

/**
 * Get unread notification count
 */
function getUnreadCount(workspaceId, userId) {
  const result = db.get(
    'SELECT COUNT(*) as count FROM notifications WHERE workspace_id = ? AND user_id = ? AND is_read = 0',
    [workspaceId, userId]
  );
  return result?.count || 0;
}

module.exports = {
  addComment,
  getComment,
  listComments,
  updateComment,
  deleteComment,
  togglePinComment,
  addReaction,
  resolveComment,
  logActivity,
  getActivityTimeline,
  createNotification,
  getNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
};
