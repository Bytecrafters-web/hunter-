const axios = require('axios');
const cheerio = require('cheerio');

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IGNORE_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'godaddy.com'];

function extractEmails(html) {
  const matches = html.match(EMAIL_REGEX) || [];
  return [...new Set(matches)].filter(e =>
    !IGNORE_DOMAINS.some(d => e.toLowerCase().endsWith(d))
  );
}

async function fetchPage(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHunterBot/1.0)' }
    });
    return data;
  } catch {
    return null;
  }
}

/**
 * Given a website URL, tries to find a contact email.
 * Checks homepage first, then common contact-page paths.
 */
async function findEmailOnWebsite(website) {
  if (!website) return null;
  let base = website.trim();
  if (!base.startsWith('http')) base = 'https://' + base;
  base = base.replace(/\/$/, '');

  const pathsToTry = ['', '/contact', '/contact-us', '/about', '/about-us'];

  for (const p of pathsToTry) {
    const html = await fetchPage(base + p);
    if (!html) continue;

    const emails = extractEmails(html);
    if (emails.length > 0) return emails[0];

    // also check mailto: links specifically via cheerio (catches obfuscated cases)
    const $ = cheerio.load(html);
    const mailto = $('a[href^="mailto:"]').first().attr('href');
    if (mailto) return mailto.replace('mailto:', '').split('?')[0];
  }

  return null;
}

/**
 * Enriches an array of leads in place - fills `email` field where missing and website exists.
 */
async function enrichLeads(leads) {
  for (const lead of leads) {
    if (!lead.email && lead.website) {
      lead.email = await findEmailOnWebsite(lead.website);
    }
  }
  return leads;
}

module.exports = { enrichLeads, findEmailOnWebsite };
