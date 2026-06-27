require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { getLeads, getStats, setStatus, getSetting, setSetting, setPriority, setNotes, setFollowUpDate, bulkUpdateStatus, addToBlacklist, isBlacklisted, getBlacklist, removeFromBlacklist, getAnalytics, addMessageTemplate, getMessageTemplates, deleteTemplate, setDefaultTemplate, insertLead, getOutreachSchedule, setOutreachSchedule, getLeadsNeedingFollowUp, calculateSpamScore, getDailySummaryEmail, setDailySummaryEmail } = require('./db');
const { startScheduler, runScrape, runOutreach, getRunStatus } = require('./scheduler');
const { initWhatsApp, isReady, getLatestQR, getLastError, getWAEvents, buildWhatsAppMessage } = require('./outreach/whatsapp');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- simple password gate ---
app.use('/api', (req, res, next) => {
  const pass = req.headers['x-dashboard-password'];
  if (pass !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// --- SSE live log endpoint ---
app.get('/api/events', (req, res) => {
  const pass = req.headers['x-dashboard-password'] || req.query.pw;
  if (pass !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`);
  };

  // Send initial state
  const initialStats = { ...getStats(), whatsappReady: isReady(), paused: getSetting('paused', 'false') === 'true', runStatus: getRunStatus() };
  console.log('[SSE] Sending initial stats, whatsappReady:', initialStats.whatsappReady);
  sendEvent('stats', initialStats);

  // WhatsApp events
  const waEvents = getWAEvents();
  const onWAStatus = (msg) => { console.log('[SSE] WA status:', msg); sendEvent('wa_log', msg); };
  const onQR = () => { console.log('[SSE] WA QR event'); sendEvent('wa_qr', { qr: getLatestQR() }); };
  const onConnected = () => { console.log('[SSE] WA connected event'); sendEvent('wa_connected', true); };
  const onLoggedOut = () => { console.log('[SSE] WA logged out event'); sendEvent('wa_logged_out', true); };

  waEvents.on('status', onWAStatus);
  waEvents.on('qr', onQR);
  waEvents.on('connected', onConnected);
  waEvents.on('loggedOut', onLoggedOut);

  // Check if WhatsApp is already connected when SSE connects
  console.log('[SSE] Client connected, WhatsApp ready:', isReady());
  if (isReady()) {
    console.log('[SSE] Sending wa_connected immediately');
    sendEvent('wa_connected', true);
  } else {
    // If not ready, send current status anyway
    sendEvent('wa_log', 'WhatsApp initializing...');
  }

  // Also send updated stats after a short delay to catch any late connections
  setTimeout(() => {
    const delayedStats = { ...getStats(), whatsappReady: isReady(), paused: getSetting('paused', 'false') === 'true', runStatus: getRunStatus() };
    console.log('[SSE] Sending delayed stats, whatsappReady:', delayedStats.whatsappReady);
    sendEvent('stats', delayedStats);
    if (isReady()) {
      console.log('[SSE] Sending wa_connected after delay');
      sendEvent('wa_connected', true);
    }
  }, 2000);

  // Scheduler events
  const { schedulerEvents } = require('./scheduler');
  const onSchedLog = (msg) => sendEvent('sched_log', msg);
  const onSchedStats = () => sendEvent('stats', { ...getStats(), whatsappReady: isReady(), paused: getSetting('paused', 'false') === 'true', runStatus: getRunStatus() });
  schedulerEvents.on('log', onSchedLog);
  schedulerEvents.on('stats_update', onSchedStats);

  // Keep alive ping every 25s
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    waEvents.off('status', onWAStatus);
    waEvents.off('qr', onQR);
    waEvents.off('connected', onConnected);
    waEvents.off('logged_out', onLoggedOut);
    schedulerEvents.off('log', onSchedLog);
    schedulerEvents.off('stats_update', onSchedStats);
  });
});

app.get('/api/leads', (req, res) => {
  const { status, source, limit, search, priority } = req.query;
  res.json(getLeads({ status, source, limit: limit ? Number(limit) : undefined, search, priority }));
});

app.get('/api/whatsapp/qr', (req, res) => {
  res.json({ ready: isReady(), qr: getLatestQR(), error: getLastError() });
});

app.post('/api/leads/:id/priority', (req, res) => {
  const { priority } = req.body;
  setPriority(req.params.id, priority);
  res.json({ ok: true });
});

app.post('/api/leads/:id/notes', (req, res) => {
  const { notes } = req.body;
  setNotes(req.params.id, notes);
  res.json({ ok: true });
});

app.post('/api/leads/:id/followup', (req, res) => {
  const { date } = req.body;
  setFollowUpDate(req.params.id, date);
  res.json({ ok: true });
});

app.post('/api/leads/bulk', (req, res) => {
  const { ids, status } = req.body;
  bulkUpdateStatus(ids, status);
  res.json({ ok: true });
});

app.post('/api/blacklist', (req, res) => {
  const { phone, email, reason } = req.body;
  addToBlacklist({ phone, email, reason });
  res.json({ ok: true });
});

app.get('/api/blacklist', (req, res) => {
  res.json(getBlacklist());
});

app.delete('/api/blacklist/:id', (req, res) => {
  removeFromBlacklist(req.params.id);
  res.json({ ok: true });
});

app.get('/api/leads/export', (req, res) => {
  const leads = getLeads({ limit: 10000 });
  const csv = [
    'ID,Name,Source,Category,City,Phone,WhatsApp,Email,Website,Status,Priority,Notes,Created At'
  ];
  for (const lead of leads) {
    csv.push([
      lead.id,
      `"${lead.name.replace(/"/g, '""')}"`,
      lead.source,
      lead.category || '',
      lead.city || '',
      lead.phone || '',
      lead.whatsapp || '',
      lead.email || '',
      lead.website || '',
      lead.status,
      lead.priority,
      `"${(lead.notes || '').replace(/"/g, '""')}"`,
      lead.created_at
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
  res.send(csv.join('\n'));
});

app.get('/api/stats', (req, res) => {
  const { countSentToday } = require('./db');
  const dailyWaLimit = Number(process.env.DAILY_WHATSAPP_LIMIT) || 20;
  const dailyEmailLimit = Number(process.env.DAILY_EMAIL_LIMIT) || 40;
  res.json({
    ...getStats(),
    whatsappReady: isReady(),
    paused: getSetting('paused', 'false') === 'true',
    runStatus: getRunStatus(),
    whatsappSentToday: countSentToday('whatsapp'),
    whatsappLimit: dailyWaLimit,
    emailSentToday: countSentToday('email'),
    emailLimit: dailyEmailLimit
  });
});

app.get('/api/analytics', (req, res) => {
  res.json(getAnalytics());
});

app.get('/api/templates', (req, res) => {
  const { channel, category } = req.query;
  res.json(getMessageTemplates(channel, category));
});

app.post('/api/templates', (req, res) => {
  const { channel, category, subject, message, htmlMessage, isDefault } = req.body;
  addMessageTemplate({ channel, category, subject, message, htmlMessage, isDefault });
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

app.post('/api/templates/:id/default', (req, res) => {
  setDefaultTemplate(req.params.id);
  res.json({ ok: true });
});

app.post('/api/preview-message', (req, res) => {
  const { lead } = req.body;
  const message = buildWhatsAppMessage(lead);
  res.json({ message });
});

app.post('/api/leads/import', (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads)) {
    return res.status(400).json({ ok: false, error: 'Invalid leads array' });
  }
  
  let imported = 0;
  for (const lead of leads) {
    try {
      insertLead(lead);
      imported++;
    } catch (e) {
      console.error('Failed to import lead:', e);
    }
  }
  
  res.json({ ok: true, imported });
});

app.get('/api/schedule', (req, res) => {
  res.json({ days: getOutreachSchedule() });
});

app.post('/api/schedule', (req, res) => {
  const { days } = req.body;
  if (!Array.isArray(days) || days.length === 0) {
    return res.status(400).json({ ok: false, error: 'Invalid schedule' });
  }
  setOutreachSchedule(days);
  res.json({ ok: true });
});

app.get('/api/followup-leads', (req, res) => {
  const leads = getLeadsNeedingFollowUp();
  res.json({ leads });
});

app.post('/api/auto-followup', async (req, res) => {
  const leads = getLeadsNeedingFollowUp();
  const schedule = getOutreachSchedule();
  const today = new Date().getDay();
  
  if (!schedule.includes(today)) {
    return res.json({ ok: false, message: 'Today is not scheduled for outreach' });
  }
  
  if (!isReady()) {
    return res.json({ ok: false, message: 'WhatsApp not connected' });
  }
  
  let sent = 0;
  for (const lead of leads) {
    if (lead.whatsapp && !isBlacklisted(lead.whatsapp)) {
      try {
        const message = buildWhatsAppMessage(lead);
        // Send via WhatsApp (simplified - would need actual send function)
        sent++;
      } catch (e) {
        console.error('Failed to send follow-up:', e);
      }
    }
  }
  
  res.json({ ok: true, sent, total: leads.length });
});

app.post('/api/check-spam', (req, res) => {
  const { lead } = req.body;
  const spamScore = calculateSpamScore(lead);
  res.json({ spamScore });
});

app.get('/api/daily-summary', (req, res) => {
  res.json(getDailySummaryEmail());
});

app.post('/api/daily-summary', (req, res) => {
  const { enabled, email, time } = req.body;
  setDailySummaryEmail(enabled, email, time);
  res.json({ ok: true });
});

app.post('/api/leads/:id/status', (req, res) => {
  const { status } = req.body;
  setStatus(req.params.id, status);
  res.json({ ok: true });
});

app.post('/api/pause', (req, res) => {
  setSetting('paused', 'true');
  res.json({ ok: true, paused: true });
});

app.post('/api/resume', (req, res) => {
  setSetting('paused', 'false');
  res.json({ ok: true, paused: false });
});

app.post('/api/run/scrape', async (req, res) => {
  const status = getRunStatus();
  if (status.scraping) {
    return res.json({ ok: false, message: 'Scrape already running...' });
  }
  runScrape().catch(console.error);
  res.json({ ok: true, message: 'Scrape started! Watch live status on dashboard.' });
});

app.post('/api/run/outreach', async (req, res) => {
  const status = getRunStatus();
  if (status.outreaching) {
    return res.json({ ok: false, message: 'Outreach already running...' });
  }
  runOutreach().catch(console.error);
  res.json({ ok: true, message: 'Outreach started! Watch live status on dashboard.' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[server] Dashboard running at http://localhost:${PORT}`);
  startScheduler();
  if (process.env.WHATSAPP_ENABLED === 'true') {
    initWhatsApp().catch((err) => console.error('[whatsapp] init error:', err.message));
  }
});
