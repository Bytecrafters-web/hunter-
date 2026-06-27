// Run with: npm run scrape:now
// Triggers one scrape cycle immediately (does NOT send outreach - that stays on schedule
// or you can call runOutreach() too once you've checked the dashboard and feel ready).
const { runScrape } = require('../scheduler');

runScrape().then(() => {
  console.log('Done. Check the dashboard at http://localhost:4000');
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
