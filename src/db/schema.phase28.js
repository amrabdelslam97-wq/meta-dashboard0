/**
 * Phase 28 — Agency Operating System & Team Collaboration
 *
 * Workspace isolation for multiple teams, clients, projects, tasks, approvals, and collaboration.
 * Integrated with existing Multi-Account and RBAC systems.
 *
 * Tables:
 *   1. workspaces          — Agency/Brand/Company workspace containers
 *   2. workspace_members   — Users within each workspace with roles
 *   3. clients             — Client profiles, contact info, Meta accounts
 *   4. projects            — Work items (Meta Ads, Google Ads, Content, etc.)
 *   5. project_tasks       — Tasks within projects
 *   6. task_subtasks       — Subtasks within tasks
 *   7. task_checklists     — Checklist items for tasks
 *   8. approvals           — Approval requests and workflow
 *   9. comments            — Comments on tasks, projects, creatives, campaigns
 *  10. activity_timeline   — Audit trail of actions
 *  11. file_uploads        — Creative assets, documents, reports
 *  12. custom_roles        — Custom role definitions
 *  13. notifications       — In-app notifications
 *  14. meeting_notes       — Meeting records and action items
 *  15. knowledge_base      — SOPs, guides, playbooks, templates
 */

const db = require('./database');
const { ensureMigrationsTable, markMigrationApplied } = require('./migrationTracker');

const MIGRATION_NAME = 'phase28_agency_os_collaboration';

const SCHEMA_SQL = `

-- ─────────────────────────────────────────────
-- TABLE: workspaces
-- Agency/Brand/Company workspace containers
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id                TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES users(id),
  workspace_type    TEXT NOT NULL CHECK(workspace_type IN ('agency','company','brand','department','client')),
  name              TEXT NOT NULL,
  logo_url          TEXT,
  industry          TEXT,
  country           TEXT,
  currency          TEXT DEFAULT 'USD',
  timezone          TEXT DEFAULT 'UTC',
  billing_email     TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','suspended')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner
  ON workspaces(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_workspaces_type
  ON workspaces(workspace_type);

-- ─────────────────────────────────────────────
-- TABLE: workspace_members
-- Users in workspace with roles and permissions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_members (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  role              TEXT NOT NULL CHECK(role IN (
    'owner','agency_admin','manager','media_buyer','designer','copywriter',
    'analyst','sales','support','client','viewer','custom'
  )),
  custom_role_id    TEXT REFERENCES custom_roles(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','suspended')),
  invited_at        TEXT,
  joined_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
  ON workspace_members(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user
  ON workspace_members(user_id);

-- ─────────────────────────────────────────────
-- TABLE: clients
-- Client profiles within workspace
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  company_name      TEXT NOT NULL,
  logo_url          TEXT,
  industry          TEXT,
  country           TEXT,
  currency          TEXT DEFAULT 'USD',
  timezone          TEXT DEFAULT 'UTC',
  primary_contact   TEXT,
  email             TEXT,
  phone             TEXT,
  marketing_manager TEXT,
  business_manager_id TEXT,
  meta_accounts_json TEXT,
  pixels_json       TEXT,
  domains_json      TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','terminated')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_workspace
  ON clients(workspace_id);

CREATE INDEX IF NOT EXISTS idx_clients_status
  ON clients(status);

-- ─────────────────────────────────────────────
-- TABLE: projects
-- Work projects (Meta Ads, Content, Video, etc)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  client_id         TEXT REFERENCES clients(id),
  name              TEXT NOT NULL,
  project_type      TEXT NOT NULL CHECK(project_type IN (
    'meta_ads','google_ads','tiktok_ads','website','branding','content','photography',
    'video','seo','email','social','other'
  )),
  description       TEXT,
  campaign_id       TEXT REFERENCES campaigns(id),
  start_date        TEXT,
  end_date          TEXT,
  budget            REAL,
  status            TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN (
    'backlog','planning','in_progress','review','completed','cancelled'
  )),
  progress_percent  INTEGER DEFAULT 0,
  owner_user_id     TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON projects(workspace_id);

CREATE INDEX IF NOT EXISTS idx_projects_client
  ON projects(client_id);

CREATE INDEX IF NOT EXISTS idx_projects_status
  ON projects(status);

-- ─────────────────────────────────────────────
-- TABLE: project_tasks
-- Tasks within projects (work items)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
  status            TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN (
    'backlog','todo','in_progress','review','approved','completed','cancelled'
  )),
  assigned_to_user_id TEXT REFERENCES users(id),
  labels_json       TEXT,
  due_date          TEXT,
  start_date        TEXT,
  progress_percent  INTEGER DEFAULT 0,
  order_index       INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project
  ON project_tasks(project_id);

CREATE INDEX IF NOT EXISTS idx_project_tasks_assigned_to
  ON project_tasks(assigned_to_user_id);

CREATE INDEX IF NOT EXISTS idx_project_tasks_status
  ON project_tasks(status);

CREATE INDEX IF NOT EXISTS idx_project_tasks_due_date
  ON project_tasks(due_date);

-- ─────────────────────────────────────────────
-- TABLE: task_subtasks
-- Subtasks within tasks
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_subtasks (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES project_tasks(id),
  title             TEXT NOT NULL,
  completed         INTEGER NOT NULL DEFAULT 0,
  assigned_to_user_id TEXT REFERENCES users(id),
  order_index       INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_subtasks_task
  ON task_subtasks(task_id);

-- ─────────────────────────────────────────────
-- TABLE: task_checklists
-- Checklist items for tasks
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_checklists (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES project_tasks(id),
  title             TEXT NOT NULL,
  completed         INTEGER NOT NULL DEFAULT 0,
  order_index       INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_checklists_task
  ON task_checklists(task_id);

-- ─────────────────────────────────────────────
-- TABLE: approvals
-- Approval workflow for campaigns, creatives, budgets
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  entity_type       TEXT NOT NULL CHECK(entity_type IN (
    'campaign','creative','budget','recommendation','decision'
  )),
  entity_id         TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  approval_level    TEXT NOT NULL CHECK(approval_level IN ('manager','director','executive','client')),
  assigned_to_user_id TEXT REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','approved','rejected','draft','revisions_requested'
  )),
  reason            TEXT,
  feedback          TEXT,
  approved_at       TEXT,
  approved_by_user_id TEXT REFERENCES users(id),
  order_index       INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_workspace
  ON approvals(workspace_id);

CREATE INDEX IF NOT EXISTS idx_approvals_entity
  ON approvals(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_approvals_status
  ON approvals(status);

CREATE INDEX IF NOT EXISTS idx_approvals_assigned_to
  ON approvals(assigned_to_user_id);

-- ─────────────────────────────────────────────
-- TABLE: comments
-- Comments on tasks, campaigns, creatives, projects
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL CHECK(entity_type IN (
    'task','project','campaign','creative','ad','approval','meeting_note'
  )),
  entity_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users(id),
  content           TEXT NOT NULL,
  mentions_json     TEXT,
  parent_comment_id TEXT REFERENCES comments(id),
  is_pinned         INTEGER NOT NULL DEFAULT 0,
  is_resolved       INTEGER NOT NULL DEFAULT 0,
  resolved_at       TEXT,
  reactions_json    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_entity
  ON comments(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_comments_user
  ON comments(user_id);

CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON comments(parent_comment_id);

-- ─────────────────────────────────────────────
-- TABLE: activity_timeline
-- Immutable audit trail of all actions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_timeline (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  action_type       TEXT NOT NULL CHECK(action_type IN (
    'login','sync','create','update','delete','approve','reject','assign',
    'comment','attachment','schedule','execute','archive','export'
  )),
  entity_type       TEXT,
  entity_id         TEXT,
  old_value         TEXT,
  new_value         TEXT,
  description       TEXT,
  ip_address        TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_workspace
  ON activity_timeline(workspace_id);

CREATE INDEX IF NOT EXISTS idx_activity_user
  ON activity_timeline(user_id);

CREATE INDEX IF NOT EXISTS idx_activity_entity
  ON activity_timeline(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_activity_action
  ON activity_timeline(action_type);

CREATE INDEX IF NOT EXISTS idx_activity_created_at
  ON activity_timeline(created_at);

-- ─────────────────────────────────────────────
-- TABLE: file_uploads
-- Creative assets, documents, reports
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_uploads (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  entity_type       TEXT CHECK(entity_type IN ('creative','campaign','project','task','approval','report')),
  entity_id         TEXT,
  file_name         TEXT NOT NULL,
  file_size         INTEGER,
  file_type         TEXT,
  file_url          TEXT NOT NULL,
  s3_key            TEXT,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  description       TEXT,
  version           INTEGER DEFAULT 1,
  parent_file_id    TEXT REFERENCES file_uploads(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_workspace
  ON file_uploads(workspace_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_entity
  ON file_uploads(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_file_uploads_uploaded_by
  ON file_uploads(uploaded_by_user_id);

-- ─────────────────────────────────────────────
-- TABLE: custom_roles
-- Custom role definitions per workspace
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_roles (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  name              TEXT NOT NULL,
  description       TEXT,
  permissions_json  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_custom_roles_workspace
  ON custom_roles(workspace_id);

-- ─────────────────────────────────────────────
-- TABLE: notifications
-- In-app notifications (email/push-ready)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  triggered_by_user_id TEXT REFERENCES users(id),
  notification_type TEXT NOT NULL CHECK(notification_type IN (
    'task_assigned','task_completed','approval_requested','approval_approved',
    'approval_rejected','comment_mentioned','comment_replied','deadline_approaching',
    'deadline_missed','team_joined','project_updated','campaign_launched'
  )),
  entity_type       TEXT,
  entity_id         TEXT,
  title             TEXT NOT NULL,
  message           TEXT,
  action_url        TEXT,
  is_read           INTEGER NOT NULL DEFAULT 0,
  read_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_workspace
  ON notifications(workspace_id);

CREATE INDEX IF NOT EXISTS idx_notifications_is_read
  ON notifications(is_read);

-- ─────────────────────────────────────────────
-- TABLE: meeting_notes
-- Meeting records with agenda and action items
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_notes (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  project_id        TEXT REFERENCES projects(id),
  title             TEXT NOT NULL,
  agenda            TEXT,
  notes             TEXT,
  participants_json TEXT,
  action_items_json TEXT,
  meeting_date      TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_workspace
  ON meeting_notes(workspace_id);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_project
  ON meeting_notes(project_id);

-- ─────────────────────────────────────────────
-- TABLE: knowledge_base
-- SOPs, guides, playbooks, templates, FAQs
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  category          TEXT NOT NULL CHECK(category IN (
    'sop','guide','playbook','template','faq','process','standard'
  )),
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  tags_json         TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  last_updated_by_user_id TEXT REFERENCES users(id),
  views             INTEGER DEFAULT 0,
  is_archived       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_workspace
  ON knowledge_base(workspace_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_category
  ON knowledge_base(category);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_archived
  ON knowledge_base(is_archived);

`;

function runPhase28Migrations() {
  try {
    ensureMigrationsTable();
    if (process.env.SKIP_MIGRATIONS) return;
    const migrationApplied = db.get(
      'SELECT 1 FROM migrations WHERE migration_name = ?',
      [MIGRATION_NAME]
    );
    if (migrationApplied) return;

    db.run(SCHEMA_SQL);
    markMigrationApplied(MIGRATION_NAME);
    console.log('✓ Phase 28 (Agency OS & Collaboration) migrations applied');
  } catch (e) {
    console.error(`Phase 28 migration error: ${e.message}`);
  }
}

module.exports = {
  runPhase28Migrations,
};
