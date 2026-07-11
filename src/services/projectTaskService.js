/**
 * Project & Task Management Service — Phase 28
 *
 * Manages projects, tasks, subtasks, checklists, and workflow.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ──────────────────────────────────
// PROJECTS
// ──────────────────────────────────

/**
 * Create a new project
 */
function createProject(workspaceId, projectData) {
  const projectId = generateId('prj');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO projects (
      id, workspace_id, client_id, name, project_type, description,
      campaign_id, start_date, end_date, budget, status,
      progress_percent, owner_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    projectId,
    workspaceId,
    projectData.client_id || null,
    projectData.name,
    projectData.project_type || 'other',
    projectData.description || null,
    projectData.campaign_id || null,
    projectData.start_date || null,
    projectData.end_date || null,
    projectData.budget || null,
    projectData.status || 'backlog',
    projectData.progress_percent || 0,
    projectData.owner_user_id,
    now,
    now,
  ]);

  return getProject(projectId);
}

/**
 * Get project details with task counts
 */
function getProject(projectId) {
  const project = db.get(`
    SELECT * FROM projects WHERE id = ?
  `, [projectId]);

  if (!project) return null;

  const taskCounts = db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status IN ('backlog', 'todo') THEN 1 ELSE 0 END) as backlog,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review
    FROM project_tasks WHERE project_id = ?
  `, [projectId]);

  return {
    ...project,
    task_counts: taskCounts || {},
  };
}

/**
 * List projects in workspace
 */
function listProjects(workspaceId, filters = {}) {
  let query = `
    SELECT p.* FROM projects p
    WHERE p.workspace_id = ?
  `;
  const params = [workspaceId];

  if (filters.client_id) {
    query += ' AND p.client_id = ?';
    params.push(filters.client_id);
  }

  if (filters.status) {
    query += ' AND p.status = ?';
    params.push(filters.status);
  }

  if (filters.project_type) {
    query += ' AND p.project_type = ?';
    params.push(filters.project_type);
  }

  query += ' ORDER BY p.updated_at DESC';

  const projects = db.all(query, params);
  return projects.map(p => getProject(p.id)).filter(p => p);
}

/**
 * Update project
 */
function updateProject(projectId, projectData) {
  const now = new Date().toISOString();
  const updates = [];
  const params = [];

  const fields = [
    'name', 'description', 'project_type', 'client_id',
    'campaign_id', 'start_date', 'end_date', 'budget',
    'status', 'progress_percent', 'owner_user_id',
  ];

  for (const field of fields) {
    if (field in projectData) {
      updates.push(`${field} = ?`);
      params.push(projectData[field] || null);
    }
  }

  if (updates.length === 0) return getProject(projectId);

  updates.push('updated_at = ?');
  params.push(now);
  params.push(projectId);

  db.run(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  return getProject(projectId);
}

// ──────────────────────────────────
// TASKS
// ──────────────────────────────────

/**
 * Create a new task
 */
function createTask(projectId, taskData) {
  const taskId = generateId('tsk');
  const now = new Date().toISOString();

  const maxOrder = db.get(
    'SELECT MAX(order_index) as max_order FROM project_tasks WHERE project_id = ?',
    [projectId]
  );

  db.run(`
    INSERT INTO project_tasks (
      id, project_id, title, description, priority, status,
      assigned_to_user_id, labels_json, due_date, start_date,
      progress_percent, order_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    taskId,
    projectId,
    taskData.title,
    taskData.description || null,
    taskData.priority || 'medium',
    taskData.status || 'backlog',
    taskData.assigned_to_user_id || null,
    JSON.stringify(taskData.labels || []),
    taskData.due_date || null,
    taskData.start_date || null,
    taskData.progress_percent || 0,
    (maxOrder?.max_order || 0) + 1,
    now,
    now,
  ]);

  return getTask(taskId);
}

/**
 * Get task with subtasks and checklists
 */
function getTask(taskId) {
  const task = db.get(`
    SELECT * FROM project_tasks WHERE id = ?
  `, [taskId]);

  if (!task) return null;

  const subtasks = db.all(`
    SELECT * FROM task_subtasks WHERE task_id = ? ORDER BY order_index
  `, [taskId]);

  const checklists = db.all(`
    SELECT * FROM task_checklists WHERE task_id = ? ORDER BY order_index
  `, [taskId]);

  const labels = task.labels_json ? JSON.parse(task.labels_json) : [];

  return {
    ...task,
    labels,
    subtasks: subtasks || [],
    checklists: checklists || [],
    checklist_percent: checklists.length > 0
      ? Math.round((checklists.filter(c => c.completed).length / checklists.length) * 100)
      : 0,
  };
}

/**
 * List tasks in project
 */
function listTasks(projectId, filters = {}) {
  let query = `
    SELECT * FROM project_tasks
    WHERE project_id = ?
  `;
  const params = [projectId];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.assigned_to_user_id) {
    query += ' AND assigned_to_user_id = ?';
    params.push(filters.assigned_to_user_id);
  }

  if (filters.priority) {
    query += ' AND priority = ?';
    params.push(filters.priority);
  }

  query += ' ORDER BY order_index, due_date, status';

  const tasks = db.all(query, params);
  return tasks.map(t => getTask(t.id));
}

/**
 * Update task
 */
function updateTask(taskId, taskData) {
  const now = new Date().toISOString();
  const updates = [];
  const params = [];

  const fields = [
    'title', 'description', 'priority', 'status',
    'assigned_to_user_id', 'due_date', 'start_date', 'progress_percent',
  ];

  for (const field of fields) {
    if (field in taskData) {
      updates.push(`${field} = ?`);
      params.push(taskData[field] || null);
    }
  }

  if (taskData.labels) {
    updates.push('labels_json = ?');
    params.push(JSON.stringify(taskData.labels));
  }

  if (updates.length === 0) return getTask(taskId);

  updates.push('updated_at = ?');
  params.push(now);
  params.push(taskId);

  db.run(
    `UPDATE project_tasks SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  return getTask(taskId);
}

/**
 * Move task to new position
 */
function moveTask(taskId, newOrder) {
  const now = new Date().toISOString();
  db.run(
    'UPDATE project_tasks SET order_index = ?, updated_at = ? WHERE id = ?',
    [newOrder, now, taskId]
  );
  return getTask(taskId);
}

// ──────────────────────────────────
// SUBTASKS
// ──────────────────────────────────

/**
 * Add subtask to task
 */
function addSubtask(taskId, title) {
  const subtaskId = generateId('sub');
  const now = new Date().toISOString();

  const maxOrder = db.get(
    'SELECT MAX(order_index) as max_order FROM task_subtasks WHERE task_id = ?',
    [taskId]
  );

  db.run(`
    INSERT INTO task_subtasks (
      id, task_id, title, completed, order_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    subtaskId,
    taskId,
    title,
    0,
    (maxOrder?.max_order || 0) + 1,
    now,
    now,
  ]);

  return db.get('SELECT * FROM task_subtasks WHERE id = ?', [subtaskId]);
}

/**
 * Toggle subtask completion
 */
function toggleSubtask(subtaskId) {
  const subtask = db.get('SELECT completed FROM task_subtasks WHERE id = ?', [subtaskId]);
  if (!subtask) return null;

  const now = new Date().toISOString();
  db.run(
    'UPDATE task_subtasks SET completed = ?, updated_at = ? WHERE id = ?',
    [1 - subtask.completed, now, subtaskId]
  );

  return db.get('SELECT * FROM task_subtasks WHERE id = ?', [subtaskId]);
}

// ──────────────────────────────────
// CHECKLISTS
// ──────────────────────────────────

/**
 * Add checklist item to task
 */
function addChecklistItem(taskId, title) {
  const checklistId = generateId('chk');
  const now = new Date().toISOString();

  const maxOrder = db.get(
    'SELECT MAX(order_index) as max_order FROM task_checklists WHERE task_id = ?',
    [taskId]
  );

  db.run(`
    INSERT INTO task_checklists (
      id, task_id, title, completed, order_index, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    checklistId,
    taskId,
    title,
    0,
    (maxOrder?.max_order || 0) + 1,
    now,
    now,
  ]);

  return db.get('SELECT * FROM task_checklists WHERE id = ?', [checklistId]);
}

/**
 * Toggle checklist item
 */
function toggleChecklistItem(checklistId) {
  const item = db.get('SELECT completed FROM task_checklists WHERE id = ?', [checklistId]);
  if (!item) return null;

  const now = new Date().toISOString();
  db.run(
    'UPDATE task_checklists SET completed = ?, updated_at = ? WHERE id = ?',
    [1 - item.completed, now, checklistId]
  );

  return db.get('SELECT * FROM task_checklists WHERE id = ?', [checklistId]);
}

module.exports = {
  createProject,
  getProject,
  listProjects,
  updateProject,
  createTask,
  getTask,
  listTasks,
  updateTask,
  moveTask,
  addSubtask,
  toggleSubtask,
  addChecklistItem,
  toggleChecklistItem,
};
