const cron = require('node-cron');
const EventEmitter = require('events');
require('dotenv').config();

const { fetchLocalLeads } = require('./scrapers/googleMaps');
const { fetchLocalLeadsOSM } = require('./scrapers/osm');
const { fetchUpworkLeads } = require('./scrapers/upworkRss');
const { enrichLeads } = require('./enrich');
const { sendEmail } = require('./outreach/email');
const { sendWhatsApp, isReady } = require('./outreach/whatsapp');
const {
  insertLead, getNewContactableLeads, markContacted,
  logSend, countSentToday, getSetting, isBlacklisted
} = require('./db');

// Live event emitter for dashboard SSE streaming
const schedulerEvents = new EventEmitter();

// Run status tracker
const runStatus = { scraping: false, outreaching: false, lastScrapeResult: null, lastOutreachResult: null };

function getRunStatus() { return { ...runStatus }; }

function log(msg) {
  const line = `[scheduler] ${msg}`;
  console.log(line);
  schedulerEvents.emit('log', msg);
}

function isPaused() { return getSetting('paused', 'false') === 'true'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScrape() {
  if (runStatus.scraping) { log('Scrape already running, skipping.'); return; }
  if (isPaused()) { log('Paused - skipping scrape.'); return; }

  runStatus.scraping = true;
  schedulerEvents.emit('stats_update');
  log('🔍 Starting scrape run...');

  const cities = (process.env.SEARCH_CITIES || '').split(',').map(s => s.trim()).filter(Boolean);
  const niches = (process.env.SEARCH_NICHES || '').split(',').map(s => s.trim()).filter(Boolean);
  const keywords = (process.env.UPWORK_KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const localSource = (process.env.LEAD_SOURCE_LOCAL || 'google').toLowerCase();

  log(`Cities: ${cities.join(', ')} | Niches: ${niches.join(', ')}`);

  let localLeads = [];
  let upworkLeads = [];

  try {
    if (localSource === 'osm' || localSource === 'both') {
      const radius = Number(process.env.OSM_RADIUS_METERS) || 6000;
      log(`Querying OpenStreetMap for ${cities.length} cities × ${niches.length} niches...`);
      const osmLeads = await fetchLocalLeadsOSM({ cities, niches, radiusMeters: radius });
      localLeads.push(...osmLeads);
      log(`OSM returned ${osmLeads.length} raw leads.`);
    }
    if ((localSource === 'google' || localSource === 'both') && process.env.GOOGLE_PLACES_API_KEY) {
      const googleLeads = await fetchLocalLeads({ cities, niches });
      localLeads.push(...googleLeads);
      log(`Google returned ${googleLeads.length} raw leads.`);
    }
    log(`Enriching ${localLeads.length} local leads (finding emails from websites)...`);
    localLeads = await enrichLeads(localLeads);
  } catch (err) {
    log(`❌ Local scrape error: ${err.message}`);
  }

  try {
    log(`Checking Upwork for: ${keywords.join(', ')}...`);
    upworkLeads = await fetchUpworkLeads({ keywords });
    log(`Upwork returned ${upworkLeads.length} job leads.`);
  } catch (err) {
    log(`❌ Upwork scrape error: ${err.message}`);
  }

  let inserted = 0;
  let duplicates = 0;
  for (const lead of [...localLeads, ...upworkLeads]) {
    const res = insertLead(lead);
    if (res.changes > 0) {
      inserted++;
      console.log(`[db] Inserted lead: ${lead.name} (${lead.source})`);
    } else {
      duplicates++;
      console.log(`[db] Duplicate lead skipped: ${lead.name} (${lead.source})`);
    }
  }

  const summary = `✅ Scrape done. ${inserted} new leads added, ${duplicates} duplicates skipped (local: ${localLeads.length}, upwork: ${upworkLeads.length}).`;
  log(summary);
  runStatus.scraping = false;
  runStatus.lastScrapeResult = summary;
  schedulerEvents.emit('stats_update');
}

async function runOutreach() {
  if (runStatus.outreaching) { log('Outreach already running, skipping.'); return; }
  if (isPaused()) { log('Paused - skipping outreach.'); return; }

  runStatus.outreaching = true;
  schedulerEvents.emit('stats_update');
  log('📤 Starting outreach run...');

  const delayMs = (Number(process.env.DELAY_BETWEEN_MESSAGES_SECONDS) || 45) * 1000;
  const dailyWaLimit = Number(process.env.DAILY_WHATSAPP_LIMIT) || 20;
  const dailyEmailLimit = Number(process.env.DAILY_EMAIL_LIMIT) || 40;

  // ---- WhatsApp ----
  if (process.env.WHATSAPP_ENABLED === 'true') {
    if (!isReady()) {
      log('⚠️ WhatsApp not connected — skipping WhatsApp outreach. Connect via dashboard.');
    } else {
      const alreadySent = countSentToday('whatsapp');
      const remaining = Math.max(0, dailyWaLimit - alreadySent);
      log(`WhatsApp: sent today=${alreadySent}, limit=${dailyWaLimit}, can send=${remaining}`);
      const leads = getNewContactableLeads('whatsapp', remaining);

      if (leads.length === 0) {
        log('No new WhatsApp-contactable leads found.');
      }

      for (const lead of leads) {
        // Check blacklist before sending
        if (isBlacklisted(lead.whatsapp, lead.email)) {
          log(`⏭️ Skipping ${lead.name} - blacklisted`);
          continue;
        }

        try {
          await sendWhatsApp(lead);
          logSend(lead.id, 'whatsapp');
          markContacted(lead.id);
          log(`✅ WhatsApp sent to ${lead.name} (${lead.whatsapp})`);
          schedulerEvents.emit('stats_update');
        } catch (err) {
          log(`❌ WhatsApp failed for ${lead.name}: ${err.message}`);
        }
        await sleep(delayMs);
      }
    }
  }

  // ---- Email ----
  const alreadySentEmail = countSentToday('email');
  const remainingEmail = Math.max(0, dailyEmailLimit - alreadySentEmail);
  log(`Email: sent today=${alreadySentEmail}, limit=${dailyEmailLimit}, can send=${remainingEmail}`);
  const emailLeads = getNewContactableLeads('email', remainingEmail);

  if (emailLeads.length === 0) {
    log('No new email-contactable leads found.');
  }

  for (const lead of emailLeads) {
    // Check blacklist before sending
    if (isBlacklisted(lead.whatsapp, lead.email)) {
      log(`⏭️ Skipping ${lead.name} - blacklisted`);
      continue;
    }

    try {
      await sendEmail(lead);
      logSend(lead.id, 'email');
      markContacted(lead.id);
      log(`✅ Email sent to ${lead.name} (${lead.email})`);
      schedulerEvents.emit('stats_update');
    } catch (err) {
      log(`❌ Email failed for ${lead.name}: ${err.message}`);
    }
    await sleep(2000);
  }

  const summary = `✅ Outreach done.`;
  log(summary);
  runStatus.outreaching = false;
  runStatus.lastOutreachResult = summary;
  schedulerEvents.emit('stats_update');
}

function startScheduler() {
  const scrapeCron = process.env.SCRAPE_CRON || '0 9 * * *';
  const outreachCron = process.env.OUTREACH_CRON || '0 10 * * *';
  cron.schedule(scrapeCron, runScrape);
  cron.schedule(outreachCron, runOutreach);
  console.log(`[scheduler] Scrape scheduled: "${scrapeCron}", Outreach scheduled: "${outreachCron}"`);
}

module.exports = { startScheduler, runScrape, runOutreach, getRunStatus, schedulerEvents };
