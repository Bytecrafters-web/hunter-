const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'leads.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,            -- 'google_maps' | 'upwork'
  category TEXT,                   -- niche / job category
  name TEXT NOT NULL,
  city TEXT,
  phone TEXT,
  whatsapp TEXT,
  email TEXT,
  website TEXT,
  job_url TEXT,                    -- for upwork leads (manual apply link)
  notes TEXT,
  status TEXT DEFAULT 'new',       -- new | contacted | replied | won | lost | skipped
  contactable INTEGER DEFAULT 1,   -- 0 for upwork (no auto outreach)
  priority TEXT DEFAULT 'normal',  -- hot | warm | cold | normal
  follow_up_date TEXT,             -- date for follow-up reminder
  score INTEGER DEFAULT 0,         -- lead quality score (0-100)
  created_at TEXT DEFAULT (datetime('now')),
  contacted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_dedupe
  ON leads (source, name, COALESCE(phone,''), COALESCE(job_url,''));

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  channel TEXT,        -- 'whatsapp' | 'email'
  sent_at TEXT DEFAULT (datetime('now')),
  day TEXT DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,        -- 'whatsapp' | 'email'
  category TEXT,               -- optional category for personalized messages
  subject TEXT,                -- for email templates
  message TEXT NOT NULL,
  html_message TEXT,           -- HTML version for email templates
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function calculateScore(lead) {
  let score = 0;
  // Phone: 30 points
  if (lead.phone) score += 30;
  // WhatsApp: 30 points
  if (lead.whatsapp) score += 30;
  // Email: 20 points
  if (lead.email) score += 20;
  // Website: 15 points
  if (lead.website) score += 15;
  // Category: 5 points
  if (lead.category) score += 5;
  return Math.min(score, 100);
}

function calculateSpamScore(lead) {
  let spamScore = 0;
  const email = lead.email || '';
  const phone = lead.phone || '';
  const whatsapp = lead.whatsapp || '';
  
  // Check for suspicious email patterns
  if (email) {
    // Free email providers (lower quality)
    const freeEmails = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com'];
    const domain = email.split('@')[1]?.toLowerCase();
    if (freeEmails.includes(domain)) spamScore += 10;
    
    // Numbers in email
    if (/\d/.test(email)) spamScore += 15;
    
    // Suspicious patterns
    if (/\+/.test(email)) spamScore += 20;
    if (email.includes('test') || email.includes('demo') || email.includes('spam')) spamScore += 25;
  }
  
  // Check phone patterns
  const contact = phone || whatsapp;
  if (contact) {
    // Very short or very long numbers
    const digits = contact.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) spamScore += 15;
    
    // Repeated digits
    if (/(\d)\1{4,}/.test(digits)) spamScore += 20;
  }
  
  // Check for missing contact info
  if (!email && !phone && !whatsapp) spamScore += 30;
  
  // Check for generic names
  const name = (lead.name || '').toLowerCase();
  if (name === 'test' || name === 'demo' || name === 'unknown' || name === 'n/a') spamScore += 20;
  
  return Math.min(spamScore, 100);
}

function insertLead(lead) {
  const score = calculateScore(lead);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads
      (source, category, name, city, phone, whatsapp, email, website, job_url, notes, contactable, priority, score)
    VALUES (@source, @category, @name, @city, @phone, @whatsapp, @email, @website, @job_url, @notes, @contactable, @priority, @score)
  `);
  return stmt.run({
    source: lead.source,
    category: lead.category || null,
    name: lead.name,
    city: lead.city || null,
    phone: lead.phone || null,
    whatsapp: lead.whatsapp || null,
    email: lead.email || null,
    website: lead.website || null,
    job_url: lead.job_url || null,
    notes: lead.notes || null,
    contactable: lead.contactable === false ? 0 : 1,
    priority: lead.priority || 'normal',
    score
  });
}

function getLeads({ status, source, limit = 200, search, priority } = {}) {
  let q = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (source) { q += ' AND source = ?'; params.push(source); }
  if (priority) { q += ' AND priority = ?'; params.push(priority); }
  if (search) {
    q += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(q).all(...params);
}

function getNewContactableLeads(channel, limit) {
  // channel: 'whatsapp' needs `whatsapp` field, 'email' needs `email` field
  const field = channel === 'whatsapp' ? 'whatsapp' : 'email';
  return db.prepare(`
    SELECT * FROM leads
    WHERE contactable = 1 AND status = 'new' AND ${field} IS NOT NULL AND ${field} != ''
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

function markContacted(id) {
  db.prepare(`UPDATE leads SET status = 'contacted', contacted_at = datetime('now') WHERE id = ?`).run(id);
}

function setStatus(id, status) {
  db.prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, id);
}

function setPriority(id, priority) {
  db.prepare(`UPDATE leads SET priority = ? WHERE id = ?`).run(priority, id);
}

function setNotes(id, notes) {
  db.prepare(`UPDATE leads SET notes = ? WHERE id = ?`).run(notes, id);
}

function setFollowUpDate(id, date) {
  db.prepare(`UPDATE leads SET follow_up_date = ? WHERE id = ?`).run(date, id);
}

function bulkUpdateStatus(ids, status) {
  const stmt = db.prepare(`UPDATE leads SET status = ? WHERE id = ?`);
  for (const id of ids) {
    stmt.run(status, id);
  }
}

function addToBlacklist({ phone, email, reason }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO blacklist (phone, email, reason)
    VALUES (@phone, @email, @reason)
  `);
  return stmt.run({ phone: phone || null, email: email || null, reason });
}

function isBlacklisted(phone, email) {
  const row = db.prepare(`
    SELECT 1 FROM blacklist WHERE phone = ? OR email = ?
  `).get(phone, email);
  return !!row;
}

function getBlacklist() {
  return db.prepare(`SELECT * FROM blacklist ORDER BY created_at DESC`).all();
}

function removeFromBlacklist(id) {
  db.prepare(`DELETE FROM blacklist WHERE id = ?`).run(id);
}

function addMessageTemplate({ channel, category, subject, message, htmlMessage, isDefault = false }) {
  const stmt = db.prepare(`
    INSERT INTO message_templates (channel, category, subject, message, html_message, is_default)
    VALUES (@channel, @category, @subject, @message, @htmlMessage, @isDefault)
  `);
  return stmt.run({ channel, category, subject, message, htmlMessage, isDefault: isDefault ? 1 : 0 });
}

function getMessageTemplates(channel, category = null) {
  let q = 'SELECT * FROM message_templates WHERE channel = ?';
  const params = [channel];
  if (category) {
    q += ' AND (category = ? OR category IS NULL)';
    params.push(category);
  }
  q += ' ORDER BY is_default DESC, created_at DESC';
  return db.prepare(q).all(...params);
}

function getRandomTemplate(channel, category = null) {
  const templates = getMessageTemplates(channel, category);
  if (!templates || templates.length === 0) return null;
  // Prefer category-specific templates
  const categoryTemplates = templates.filter(t => t.category === category);
  const pool = categoryTemplates.length > 0 ? categoryTemplates : templates;
  return pool[Math.floor(Math.random() * pool.length)];
}

function deleteTemplate(id) {
  db.prepare(`DELETE FROM message_templates WHERE id = ?`).run(id);
}

function setDefaultTemplate(id) {
  const template = db.prepare('SELECT channel FROM message_templates WHERE id = ?').get(id);
  if (!template) return;
  db.prepare(`UPDATE message_templates SET is_default = 0 WHERE channel = ?`).run(template.channel);
  db.prepare(`UPDATE message_templates SET is_default = 1 WHERE id = ?`).run(id);
}

function logSend(leadId, channel) {
  db.prepare(`INSERT INTO send_log (lead_id, channel) VALUES (?, ?)`).run(leadId, channel);
}

function countSentToday(channel) {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM send_log WHERE channel = ? AND day = date('now')
  `).get(channel);
  return row.c;
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getOutreachSchedule() {
  const schedule = getSetting('outreach_schedule', '1,2,3,4,5,6,0'); // Default: all days (0=Sunday, 6=Saturday)
  return schedule.split(',').map(Number);
}

function setOutreachSchedule(days) {
  setSetting('outreach_schedule', days.join(','));
}

function getDailySummaryEmail() {
  const enabled = getSetting('daily_summary_enabled', 'false');
  const email = getSetting('daily_summary_email', '');
  const time = getSetting('daily_summary_time', '09:00');
  return { enabled: enabled === 'true', email, time };
}

function setDailySummaryEmail(enabled, email, time) {
  setSetting('daily_summary_enabled', enabled ? 'true' : 'false');
  setSetting('daily_summary_email', email);
  setSetting('daily_summary_time', time);
}

function getLeadsNeedingFollowUp(daysSinceContact = 7) {
  const stmt = db.prepare(`
    SELECT * FROM leads
    WHERE status = 'contacted'
      AND updated_at <= date('now', '-' || ? || ' days')
      AND (follow_up_date IS NULL OR follow_up_date <= date('now'))
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  return stmt.all(daysSinceContact);
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM leads').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM leads GROUP BY status').all();
  const bySource = db.prepare('SELECT source, COUNT(*) c FROM leads GROUP BY source').all();
  return { total, byStatus, bySource };
}

function getAnalytics() {
  // Daily leads for last 30 days
  const dailyLeads = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM leads
    WHERE created_at >= date('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all();

  // City breakdown
  const byCity = db.prepare(`
    SELECT city, COUNT(*) as count
    FROM leads
    WHERE city IS NOT NULL AND city != ''
    GROUP BY city
    ORDER BY count DESC
    LIMIT 10
  `).all();

  // Category breakdown
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM leads
    WHERE category IS NOT NULL AND category != ''
    GROUP BY category
    ORDER BY count DESC
    LIMIT 10
  `).all();

  // Conversion rate
  const contacted = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'contacted'").get().c;
  const won = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'won'").get().c;
  const conversionRate = contacted > 0 ? ((won / contacted) * 100).toFixed(1) : 0;

  // Follow-up reminders (next 7 days)
  const followUps = db.prepare(`
    SELECT id, name, city, follow_up_date, status, whatsapp, email
    FROM leads
    WHERE follow_up_date IS NOT NULL
      AND follow_up_date >= date('now')
      AND follow_up_date <= date('now', '+7 days')
      AND status NOT IN ('won', 'lost')
    ORDER BY follow_up_date ASC
    LIMIT 10
  `).all();

  // Potential duplicates (same phone or email)
  const duplicates = db.prepare(`
    SELECT phone, email, COUNT(*) as count
    FROM leads
    WHERE phone IS NOT NULL OR email IS NOT NULL
    GROUP BY phone, email
    HAVING count > 1
    LIMIT 10
  `).all();

  return { dailyLeads, byCity, byCategory, conversionRate, contacted, won, followUps, duplicates };
}

module.exports = {
  db, insertLead, getLeads, getNewContactableLeads, markContacted,
  setStatus, setPriority, setNotes, setFollowUpDate, bulkUpdateStatus,
  addToBlacklist, isBlacklisted, getBlacklist, removeFromBlacklist,
  addMessageTemplate, getMessageTemplates, getRandomTemplate, deleteTemplate, setDefaultTemplate,
  logSend, countSentToday, getSetting, setSetting, getOutreachSchedule, setOutreachSchedule, getLeadsNeedingFollowUp, getStats, getAnalytics, calculateSpamScore, getDailySummaryEmail, setDailySummaryEmail
};
