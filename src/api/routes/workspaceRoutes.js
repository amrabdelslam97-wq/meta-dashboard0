/**
 * Workspace Routes — Phase 28
 *
 * API endpoints for workspace management, client management, projects,
 * tasks, approvals, and collaboration.
 */

const express = require('express');
const router = express.Router();

const workspaceService = require('../../services/workspaceService');
const clientService = require('../../services/clientManagementService');
const projectService = require('../../services/projectTaskService');
const approvalService = require('../../services/approvalWorkflowService');
const collaborationService = require('../../services/collaborationService');

// ──────────────────────────────────
// WORKSPACES
// ──────────────────────────────────

/**
 * POST /api/v1/workspaces
 * Create new workspace
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const workspace = await workspaceService.createWorkspace(userId, req.body);
    res.status(201).json(workspace);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces
 * List user's workspaces
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const workspaces = await workspaceService.getUserWorkspaces(userId);
    res.json(workspaces);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId
 * Get workspace details
 */
router.get('/:workspaceId', async (req, res) => {
  try {
    const workspace = await workspaceService.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const analytics = await workspaceService.getWorkspaceAnalytics(req.params.workspaceId);
    res.json({ ...workspace, analytics });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// WORKSPACE MEMBERS
// ──────────────────────────────────

/**
 * GET /api/v1/workspaces/:workspaceId/members
 * List workspace members
 */
router.get('/:workspaceId/members', async (req, res) => {
  try {
    const members = await workspaceService.getWorkspaceMembers(req.params.workspaceId);
    res.json(members);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/v1/workspaces/:workspaceId/members
 * Add member to workspace
 */
router.post('/:workspaceId/members', async (req, res) => {
  try {
    const member = await workspaceService.addWorkspaceMember(
      req.params.workspaceId,
      req.body.user_id,
      req.body.role
    );
    res.status(201).json(member);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/v1/workspaces/:workspaceId/members/:userId
 * Update member role
 */
router.patch('/:workspaceId/members/:userId', async (req, res) => {
  try {
    const member = await workspaceService.updateMemberRole(
      req.params.workspaceId,
      req.params.userId,
      req.body.role
    );
    res.json(member);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * DELETE /api/v1/workspaces/:workspaceId/members/:userId
 * Remove member from workspace
 */
router.delete('/:workspaceId/members/:userId', async (req, res) => {
  try {
    const result = await workspaceService.removeWorkspaceMember(
      req.params.workspaceId,
      req.params.userId
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// CLIENTS
// ──────────────────────────────────

/**
 * POST /api/v1/workspaces/:workspaceId/clients
 * Create new client
 */
router.post('/:workspaceId/clients', async (req, res) => {
  try {
    const client = await clientService.createClient(req.params.workspaceId, req.body);
    res.status(201).json(client);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId/clients
 * List clients
 */
router.get('/:workspaceId/clients', async (req, res) => {
  try {
    const clients = await clientService.listClients(req.params.workspaceId, req.query);
    res.json(clients);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/clients/:clientId
 * Get client details
 */
router.get('/clients/:clientId', async (req, res) => {
  try {
    const client = await clientService.getClient(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const stats = await clientService.getClientStats(req.params.clientId);
    res.json({ ...client, stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/v1/clients/:clientId
 * Update client
 */
router.patch('/clients/:clientId', async (req, res) => {
  try {
    const client = await clientService.updateClient(req.params.clientId, req.body);
    res.json(client);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/v1/clients/:clientId/meta-accounts
 * Add Meta account to client
 */
router.post('/clients/:clientId/meta-accounts', async (req, res) => {
  try {
    const client = await clientService.addMetaAccount(req.params.clientId, req.body);
    res.json(client);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// PROJECTS
// ──────────────────────────────────

/**
 * POST /api/v1/workspaces/:workspaceId/projects
 * Create new project
 */
router.post('/:workspaceId/projects', async (req, res) => {
  try {
    const project = await projectService.createProject(req.params.workspaceId, req.body);
    res.status(201).json(project);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId/projects
 * List projects
 */
router.get('/:workspaceId/projects', async (req, res) => {
  try {
    const projects = await projectService.listProjects(req.params.workspaceId, req.query);
    res.json(projects);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/projects/:projectId
 * Get project details
 */
router.get('/projects/:projectId', async (req, res) => {
  try {
    const project = await projectService.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/v1/projects/:projectId
 * Update project
 */
router.patch('/projects/:projectId', async (req, res) => {
  try {
    const project = await projectService.updateProject(req.params.projectId, req.body);
    res.json(project);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// TASKS
// ──────────────────────────────────

/**
 * POST /api/v1/projects/:projectId/tasks
 * Create task
 */
router.post('/projects/:projectId/tasks', async (req, res) => {
  try {
    const task = await projectService.createTask(req.params.projectId, req.body);
    res.status(201).json(task);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/projects/:projectId/tasks
 * List tasks
 */
router.get('/projects/:projectId/tasks', async (req, res) => {
  try {
    const tasks = await projectService.listTasks(req.params.projectId, req.query);
    res.json(tasks);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/tasks/:taskId
 * Get task details
 */
router.get('/tasks/:taskId', async (req, res) => {
  try {
    const task = await projectService.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * PATCH /api/v1/tasks/:taskId
 * Update task
 */
router.patch('/tasks/:taskId', async (req, res) => {
  try {
    const task = await projectService.updateTask(req.params.taskId, req.body);
    res.json(task);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// APPROVALS
// ──────────────────────────────────

/**
 * POST /api/v1/workspaces/:workspaceId/approvals
 * Create approval request
 */
router.post('/:workspaceId/approvals', async (req, res) => {
  try {
    const approval = await approvalService.createApprovalRequest(req.params.workspaceId, req.body);
    res.status(201).json(approval);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId/approvals
 * List pending approvals
 */
router.get('/:workspaceId/approvals', async (req, res) => {
  try {
    const approvals = await approvalService.listPendingApprovals(req.params.workspaceId, req.query);
    res.json(approvals);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/v1/approvals/:approvalId/approve
 * Approve request
 */
router.post('/approvals/:approvalId/approve', async (req, res) => {
  try {
    const userId = req.user?.id;
    const approval = await approvalService.approveRequest(
      req.params.approvalId,
      userId,
      req.body.feedback
    );
    res.json(approval);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/v1/approvals/:approvalId/reject
 * Reject request
 */
router.post('/approvals/:approvalId/reject', async (req, res) => {
  try {
    const userId = req.user?.id;
    const approval = await approvalService.rejectRequest(
      req.params.approvalId,
      userId,
      req.body.feedback
    );
    res.json(approval);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ──────────────────────────────────
// COMMENTS & COLLABORATION
// ──────────────────────────────────

/**
 * POST /api/v1/:entityType/:entityId/comments
 * Add comment
 */
router.post('/:entityType/:entityId/comments', async (req, res) => {
  try {
    const userId = req.user?.id;
    const comment = await collaborationService.addComment(
      req.params.entityType,
      req.params.entityId,
      userId,
      req.body.content,
      req.body.mentions
    );
    res.status(201).json(comment);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/:entityType/:entityId/comments
 * List comments
 */
router.get('/:entityType/:entityId/comments', async (req, res) => {
  try {
    const comments = await collaborationService.listComments(
      req.params.entityType,
      req.params.entityId
    );
    res.json(comments);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId/activity
 * Get activity timeline
 */
router.get('/:workspaceId/activity', async (req, res) => {
  try {
    const activity = await collaborationService.getActivityTimeline(req.params.workspaceId, req.query);
    res.json(activity);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/v1/workspaces/:workspaceId/notifications
 * List notifications
 */
router.get('/:workspaceId/notifications', async (req, res) => {
  try {
    const userId = req.user?.id;
    const notifications = await collaborationService.listNotifications(
      req.params.workspaceId,
      userId,
      req.query
    );
    res.json(notifications);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/v1/notifications/:notificationId/read
 * Mark notification as read
 */
router.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const notification = await collaborationService.markNotificationRead(req.params.notificationId);
    res.json(notification);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
