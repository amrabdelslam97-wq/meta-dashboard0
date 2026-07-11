/**
 * Client Management Service — Phase 28
 *
 * Manages client profiles, contacts, Meta accounts, pixels, domains.
 */

const db = require('../db/database');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Create a new client
 */
function createClient(workspaceId, clientData) {
  const clientId = generateId('cli');
  const now = new Date().toISOString();

  db.run(`
    INSERT INTO clients (
      id, workspace_id, company_name, logo_url, industry, country,
      currency, timezone, primary_contact, email, phone,
      marketing_manager, business_manager_id, meta_accounts_json,
      pixels_json, domains_json, notes, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    clientId,
    workspaceId,
    clientData.company_name,
    clientData.logo_url || null,
    clientData.industry || null,
    clientData.country || null,
    clientData.currency || 'USD',
    clientData.timezone || 'UTC',
    clientData.primary_contact || null,
    clientData.email || null,
    clientData.phone || null,
    clientData.marketing_manager || null,
    clientData.business_manager_id || null,
    JSON.stringify(clientData.meta_accounts || []),
    JSON.stringify(clientData.pixels || []),
    JSON.stringify(clientData.domains || []),
    clientData.notes || null,
    clientData.status || 'active',
    now,
    now,
  ]);

  return getClient(clientId);
}

/**
 * Get client details
 */
function getClient(clientId) {
  const client = db.get(`
    SELECT * FROM clients WHERE id = ?
  `, [clientId]);

  if (!client) return null;

  return {
    ...client,
    meta_accounts: client.meta_accounts_json ? JSON.parse(client.meta_accounts_json) : [],
    pixels: client.pixels_json ? JSON.parse(client.pixels_json) : [],
    domains: client.domains_json ? JSON.parse(client.domains_json) : [],
  };
}

/**
 * List clients in workspace
 */
function listClients(workspaceId, filters = {}) {
  let query = 'SELECT * FROM clients WHERE workspace_id = ?';
  const params = [workspaceId];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.industry) {
    query += ' AND industry = ?';
    params.push(filters.industry);
  }

  if (filters.search) {
    query += ' AND (company_name LIKE ? OR email LIKE ? OR primary_contact LIKE ?)';
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY company_name ASC';

  const clients = db.all(query, params);
  return clients.map(c => ({
    ...c,
    meta_accounts: c.meta_accounts_json ? JSON.parse(c.meta_accounts_json) : [],
    pixels: c.pixels_json ? JSON.parse(c.pixels_json) : [],
    domains: c.domains_json ? JSON.parse(c.domains_json) : [],
  }));
}

/**
 * Update client
 */
function updateClient(clientId, clientData) {
  const now = new Date().toISOString();
  const updates = [];
  const params = [];

  const fields = [
    'company_name', 'logo_url', 'industry', 'country',
    'currency', 'timezone', 'primary_contact', 'email',
    'phone', 'marketing_manager', 'business_manager_id', 'notes', 'status',
  ];

  for (const field of fields) {
    if (field in clientData) {
      updates.push(`${field} = ?`);
      params.push(clientData[field] || null);
    }
  }

  if (clientData.meta_accounts) {
    updates.push('meta_accounts_json = ?');
    params.push(JSON.stringify(clientData.meta_accounts));
  }

  if (clientData.pixels) {
    updates.push('pixels_json = ?');
    params.push(JSON.stringify(clientData.pixels));
  }

  if (clientData.domains) {
    updates.push('domains_json = ?');
    params.push(JSON.stringify(clientData.domains));
  }

  if (updates.length === 0) return getClient(clientId);

  updates.push('updated_at = ?');
  params.push(now);
  params.push(clientId);

  db.run(
    `UPDATE clients SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  return getClient(clientId);
}

/**
 * Add Meta account to client
 */
function addMetaAccount(clientId, metaAccount) {
  const client = getClient(clientId);
  if (!client) return { error: 'Client not found' };

  const accounts = client.meta_accounts || [];
  const accountId = metaAccount.account_id || crypto.randomBytes(4).toString('hex');

  accounts.push({
    id: accountId,
    name: metaAccount.name,
    account_id: metaAccount.account_id,
    access_token_encrypted: metaAccount.access_token_encrypted,
    status: metaAccount.status || 'active',
    added_at: new Date().toISOString(),
  });

  return updateClient(clientId, { meta_accounts: accounts });
}

/**
 * Add pixel to client
 */
function addPixel(clientId, pixel) {
  const client = getClient(clientId);
  if (!client) return { error: 'Client not found' };

  const pixels = client.pixels || [];
  const pixelId = pixel.id || crypto.randomBytes(4).toString('hex');

  pixels.push({
    id: pixelId,
    name: pixel.name,
    pixel_id: pixel.pixel_id,
    status: pixel.status || 'active',
    added_at: new Date().toISOString(),
  });

  return updateClient(clientId, { pixels });
}

/**
 * Add domain to client
 */
function addDomain(clientId, domain) {
  const client = getClient(clientId);
  if (!client) return { error: 'Client not found' };

  const domains = client.domains || [];
  const domainId = domain.id || crypto.randomBytes(4).toString('hex');

  domains.push({
    id: domainId,
    name: domain.name,
    domain: domain.domain,
    verified: domain.verified || false,
    status: domain.status || 'active',
    added_at: new Date().toISOString(),
  });

  return updateClient(clientId, { domains });
}

/**
 * Get client statistics
 */
function getClientStats(clientId) {
  const client = getClient(clientId);
  if (!client) return null;

  const projects = db.all(
    'SELECT id, status FROM projects WHERE client_id = ?',
    [clientId]
  );

  const projectStatuses = {
    total: projects.length,
    active: projects.filter(p => p.status === 'in_progress').length,
    completed: projects.filter(p => p.status === 'completed').length,
    cancelled: projects.filter(p => p.status === 'cancelled').length,
  };

  const campaigns = db.all(`
    SELECT c.id, c.status FROM campaigns c
    INNER JOIN projects p ON c.id = p.campaign_id
    WHERE p.client_id = ?
  `, [clientId]);

  const campaignStatuses = {
    total: campaigns.length,
    active: campaigns.filter(c => c.status === 'active').length,
    paused: campaigns.filter(c => c.status === 'paused').length,
    archived: campaigns.filter(c => c.status === 'archived').length,
  };

  return {
    ...projectStatuses,
    campaigns: campaignStatuses,
    meta_accounts_count: client.meta_accounts?.length || 0,
    pixels_count: client.pixels?.length || 0,
    domains_count: client.domains?.length || 0,
  };
}

module.exports = {
  createClient,
  getClient,
  listClients,
  updateClient,
  addMetaAccount,
  addPixel,
  addDomain,
  getClientStats,
};
