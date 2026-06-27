const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Upwork RSS feeds (410 Gone) - replaced with direct Upwork search scrape.
 * Uses public Upwork search HTML pages - no auth needed for browsing.
 * contactable = false (no contact info available - apply manually via job_url)
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

const HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchUpworkLeads({ keywords }) {
  const leads = [];

  for (const keyword of keywords) {
    let success = false;
    let lastError = null;

    // Try with different user agents
    for (let attempt = 0; attempt < USER_AGENTS.length && !success; attempt++) {
      try {
        // Use Upwork public search URL
        const searchUrl = `https://www.upwork.com/nx/jobs/search/?q=${encodeURIComponent(keyword)}&sort=recency`;

        const headers = {
          ...HEADERS,
          'User-Agent': getRandomUserAgent()
        };

        const resp = await axios.get(searchUrl, { headers, timeout: 15000 });
        const data = resp.data;

        // Process the data
        let jobs = [];

        // Method 1: JSON in script tag
        const jsonMatch = data.match(/"jobs"\s*:\s*(\[[\s\S]*?\])\s*,\s*"totalCount"/);
        if (jsonMatch) {
          try {
            jobs = JSON.parse(jsonMatch[1]).slice(0, 10);
            for (const job of jobs) {
              leads.push({
                source: 'upwork',
                category: keyword,
                name: job.title || 'Upwork Job',
                city: null,
                phone: null,
                whatsapp: null,
                email: null,
                website: null,
                job_url: job.ciphertext ? `https://www.upwork.com/jobs/~${job.ciphertext}` : null,
                notes: (job.description || '').slice(0, 400),
                contactable: false
              });
            }
            console.log(`[upwork] Found ${jobs.length} jobs for "${keyword}" via JSON (attempt ${attempt + 1})`);
            success = true;
            await sleep(3000);
            break;
          } catch {}
        }

        // Method 2: Parse HTML with cheerio
        const $ = cheerio.load(data);
        $('article[data-test="job-tile"], [data-test="job-tile"]').each((i, el) => {
          if (i >= 10) return false;
          const title = $(el).find('[data-test="job-title"], h2 a, .job-title').text().trim();
          const link = $(el).find('a[data-test="job-title-link"], h2 a').attr('href');
          const desc = $(el).find('[data-test="job-description-text"], .job-description').text().trim();
          if (title) {
            leads.push({
              source: 'upwork',
              category: keyword,
              name: title,
              city: null,
              phone: null,
              whatsapp: null,
              email: null,
              website: null,
              job_url: link ? (link.startsWith('http') ? link : `https://www.upwork.com${link}`) : null,
              notes: desc.slice(0, 400),
              contactable: false
            });
          }
        });

        if (leads.filter(l => l.category === keyword).length > 0) {
          console.log(`[upwork] Found ${leads.filter(l => l.category === keyword).length} jobs for "${keyword}" via HTML (attempt ${attempt + 1})`);
          success = true;
          await sleep(3000);
          break;
        }

        // Method 3: Minimal fallback
        const titlePattern = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*jobs[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        let count = 0;
        while ((m = titlePattern.exec(data)) && count < 10) {
          const href = m[1];
          const title = m[2].replace(/<[^>]+>/g, '').trim();
          if (title.length > 10 && title.length < 200) {
            leads.push({
              source: 'upwork',
              category: keyword,
              name: title,
              city: null, phone: null, whatsapp: null, email: null, website: null,
              job_url: href.startsWith('http') ? href : `https://www.upwork.com${href}`,
              notes: `Search: ${keyword}`,
              contactable: false
            });
            count++;
          }
        }

        if (leads.filter(l => l.category === keyword).length > 0) {
          console.log(`[upwork] Found ${leads.filter(l => l.category === keyword).length} jobs for "${keyword}" via fallback (attempt ${attempt + 1})`);
          success = true;
          await sleep(3000);
          break;
        }

        console.log(`[upwork] No jobs found for "${keyword}" (attempt ${attempt + 1})`);
        await sleep(2000);

      } catch (fetchErr) {
        lastError = fetchErr;
        console.warn(`[upwork] Attempt ${attempt + 1} failed for "${keyword}": ${fetchErr.message}`);
        await sleep(2000);
      }
    }

    if (!success) {
      console.error(`[upwork] All attempts failed for "${keyword}": ${lastError?.message || 'Unknown error'}`);
    }
  }

  return leads;
}

module.exports = { fetchUpworkLeads };
