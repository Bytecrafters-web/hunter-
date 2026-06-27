const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { getRandomTemplate } = require('../db');

let sock = null;
let ready = false;
let latestQR = null;
let lastError = null;
let connecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

// Event emitter for live log streaming to dashboard
const EventEmitter = require('events');
const waEvents = new EventEmitter();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function clearSession() {
  const sessionPath = path.join(__dirname, '..', '..', 'wa-session');
  if (fs.existsSync(sessionPath)) {
    fs.readdirSync(sessionPath).forEach(f => {
      // Keep the directory, just delete files
      try { fs.unlinkSync(path.join(sessionPath, f)); } catch {}
    });
  }
}

function emitStatus(msg) {
  console.log('[whatsapp]', msg);
  waEvents.emit('status', msg);
}

async function initWhatsApp() {
  if (connecting) return sock;
  // If already ready, return existing socket
  if (ready && sock) return sock;
  
  connecting = true;
  ready = false;
  latestQR = null;
  lastError = null;

  emitStatus('Initializing WhatsApp connection...');

  const sessionPath = path.join(__dirname, '..', '..', 'wa-session');
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
  } catch (err) {
    emitStatus('Session read error, clearing session: ' + err.message);
    clearSession();
    ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
  }

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307]; // fallback version
    emitStatus('Could not fetch latest Baileys version, using fallback.');
  }

  const logger = pino({ level: 'silent' }); // suppress ALL pino logs - we handle our own

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
    // Disable init queries that cause Timed Out errors
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      lastError = null;
      emitStatus('QR code ready — scan with WhatsApp on your phone.');
      waEvents.emit('qr', qr);
    }

    if (connection === 'open') {
      ready = true;
      connecting = false;
      reconnectAttempts = 0;
      latestQR = null;
      lastError = null;
      emitStatus('✅ WhatsApp connected successfully!');
      console.log('[whatsapp] Emitting connected event');
      waEvents.emit('connected');
    }

    if (connection === 'close') {
      ready = false;
      connecting = false;

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || 'Unknown';

      emitStatus(`Connection closed. Code: ${statusCode}, Reason: ${errorMsg}`);

      // 401 = logged out / conflict (device removed / another session opened)
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        lastError = 'Logged out (another device opened same WhatsApp). Session cleared — scan QR again.';
        emitStatus('Clearing old session due to logout/conflict...');
        clearSession();
        reconnectAttempts = 0;
        console.log('[whatsapp] Emitting logged_out event');
        waEvents.emit('loggedOut');
        // Auto re-init after short delay so new QR appears
        setTimeout(() => {
          initWhatsApp().catch(e => { lastError = e.message; emitStatus('Re-init error: ' + e.message); });
        }, 3000);
        return;
      }

      if (statusCode === DisconnectReason.badSession) {
        lastError = 'Bad session file. Clearing and re-scanning...';
        emitStatus(lastError);
        clearSession();
        reconnectAttempts = 0;
        setTimeout(() => {
          initWhatsApp().catch(e => { lastError = e.message; });
        }, 3000);
        return;
      }

      // Other disconnects: retry with backoff
      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT) {
        const backoff = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        emitStatus(`Reconnecting in ${Math.round(backoff/1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
        setTimeout(() => {
          initWhatsApp().catch(e => { lastError = e.message; emitStatus('Reconnect error: ' + e.message); });
        }, backoff);
      } else {
        lastError = `Max reconnect attempts reached. Please restart the server.`;
        emitStatus(lastError);
        waEvents.emit('error', lastError);
      }
    }
  });

  // Suppress noisy errors from baileys internals (init queries timeout etc.)
  sock.ev.on('CB:stream:error', () => {}); // handled above in connection.update
  
  return sock;
}

function buildWhatsAppMessage(lead) {
  // Try to get category-specific template first
  const template = getRandomTemplate('whatsapp', lead.category);
  
  if (template) {
    // Replace placeholders in template
    return template.message
      .replace(/{name}/g, lead.name || 'there')
      .replace(/{city}/g, lead.city || '')
      .replace(/{category}/g, lead.category || '');
  }
  
  // Fallback to default message
  const niceName = lead.name || 'there';
  const service = lead.source !== 'upwork'
    ? 'website + WhatsApp order/booking automation'
    : 'web development & automation';

  return `Assalam o Alaikum! 👋\n\nI noticed *${niceName}*${lead.city ? ` in ${lead.city}` : ''} and had a quick idea about ${service} that could help bring in more customers.\n\nI'm Rauf - I build websites & WhatsApp bots for businesses (8+ yrs experience).\n\nOpen to a 2-min chat or a free mockup? No pressure at all 🙂`;
}

async function sendWhatsApp(lead) {
  if (!sock || !ready) throw new Error('WhatsApp client not ready yet.');
  const jid = `${lead.whatsapp}@s.whatsapp.net`;
  const message = buildWhatsAppMessage(lead);
  return sock.sendMessage(jid, { text: message });
}

function isReady() { return ready; }
function getLatestQR() { return latestQR; }
function getLastError() { return lastError; }
function getWAEvents() { return waEvents; }

module.exports = { initWhatsApp, sendWhatsApp, buildWhatsAppMessage, isReady, getLatestQR, getLastError, getWAEvents };
