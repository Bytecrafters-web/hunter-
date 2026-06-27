# Lead Hunter

Automated client-hunting tool: scrapes leads (local businesses via Google Maps + Upwork jobs),
enriches contact info, auto-sends WhatsApp + Email outreach (with rate limits), and gives you
a dashboard to track everything.

## What it actually does daily

1. **9:00 AM** — scrapes Google Maps for businesses (in your chosen cities/niches) + Upwork RSS for job leads.
   Local leads get enriched with an email pulled from their website (if available).
2. **10:00 AM** — sends WhatsApp + Email outreach to **local business leads only** (rate-limited).
   Upwork leads are added to your dashboard for **manual** apply — see "Why Upwork is manual" below.
3. You check the dashboard, move leads through `new → contacted → replied → won/lost`.

## Setup

```bash
npm install
cp .env.example .env
```

By default, `LEAD_SOURCE_LOCAL=osm` — **100% free, no API key, no billing**, using OpenStreetMap.
This works out of the box, no setup needed for local leads.

When you're ready to add Google (richer phone/website data), get a key and set
`LEAD_SOURCE_LOCAL=both` in `.env`:

| Variable | Where to get it |
|---|---|
| `GOOGLE_PLACES_API_KEY` *(optional)* | console.cloud.google.com → enable "Places API" → Credentials. Free $200/month credit. |
| `SMTP_USER` / `SMTP_PASS` | Gmail → enable 2FA → create an "App Password" (not your real password) |
| `SEARCH_CITIES` / `SEARCH_NICHES` | edit to your target market |
| `UPWORK_KEYWORDS` | your skill keywords (no account needed, it's a public RSS feed) |

### OSM vs Google — what's different

- **OSM (free)**: no key, no cost, no limits. But phone/website are only present if the business
  (or someone) added them to OpenStreetMap — coverage in small cities like Mansehra/Naran is patchy.
  You'll still get name + location + category for everyone, just not always contact info.
- **Google (paid past free tier)**: almost always has phone + website. Free $200/month credit
  covers a lot at this scale, but isn't unlimited.
- **`LEAD_SOURCE_LOCAL=both`**: runs both and merges into the dashboard — most coverage, but you'll
  occasionally see the same business twice (once per source) since they're not cross-deduped.

Run it:
```bash
npm start
```
Open `http://localhost:4000`, enter the dashboard password from `.env`, then click
**"📱 Connect WhatsApp"** — the QR code shows right there in the dashboard (no terminal, no
Chrome install needed — uses [Baileys](https://github.com/WhiskeySockets/Baileys), which talks
to WhatsApp directly over WebSocket instead of automating a browser).
Scan it with WhatsApp → Linked Devices → Link a Device. After that it stays logged in
(session saved in `./wa-session`).

**If WhatsApp says "Logged out" or won't reconnect**: delete the `wa-session` folder and restart
(`npm start`) to re-link from scratch.

Test scraping immediately without waiting for the cron schedule:
```bash
npm run scrape:now
```

## Deploying so it runs 24/7

Cheapest reliable option: a small VPS (DigitalOcean/Contabo/Hetznet ~$4-5/mo) since whatsapp-web.js
needs a persistent Chromium session — won't survive serverless/Vercel-style hosting.

```bash
# on the VPS
git clone <your repo>
cd lead-hunter
npm install
cp .env.example .env   # fill in real values
npm i -g pm2
pm2 start src/server.js --name lead-hunter
pm2 save
pm2 startup   # makes it survive reboots
```

Scan the WhatsApp QR once via `pm2 logs lead-hunter`, then it's fully unattended.

## Why Upwork leads are manual-only

Upwork's public RSS feed (the one this tool uses) never includes the client's email or phone —
that's intentional on their end so people don't bypass the platform. Auto-applying to jobs via bot
also breaks Upwork's terms and risks your account. So Upwork leads just populate your dashboard
with a direct link — you read it and submit the proposal yourself in under a minute.

## Important safety notes — please actually read these

- **WhatsApp ban risk**: Baileys connects through WhatsApp's own protocol on your real number,
  similar trust level to any unofficial automation tool. Sending too many messages too fast is
  the #1 way numbers get banned. Defaults are set conservative (`DAILY_WHATSAPP_LIMIT=20`, 45 sec
  between messages) — don't crank these up fast. If this scales well, migrate to the official
  WhatsApp Business Platform API later.
- **Cold email**: keep it personalized and low-volume, include your real name/identity (already
  in the template), and stop emailing anyone who asks you to. This keeps you on the right side of
  basic anti-spam norms even though Pakistan doesn't have strict CAN-SPAM-style enforcement.
- **Google Places API costs money past the free tier** if you scrape a huge number of cities/niches
  daily — start with 2-3 cities and check your GCP billing dashboard the first week.
- The `paused` toggle in the dashboard stops both scraping and outreach immediately if anything
  looks off (e.g., WhatsApp warns you, or you want to edit message templates).

## Editing message templates

- Email template: `src/outreach/email.js` → `buildEmailTemplate()`
- WhatsApp template: `src/outreach/whatsapp.js` → `buildWhatsAppMessage()`

Both currently pitch "website + WhatsApp bot" for local leads — tweak the wording per niche if
you want restaurants to hear a different pitch than clinics, etc. (Easy next step: add a
`category`-based switch inside those functions.)

## File map

```
src/
  db.js                  # SQLite schema + queries (leads.db created on first run)
  scrapers/
    googleMaps.js         # local business leads
    upworkRss.js           # job leads (manual apply)
    runOnce.js             # manual trigger for testing
  enrich.js               # finds email on lead's website
  outreach/
    email.js              # nodemailer sender + template
    whatsapp.js            # whatsapp-web.js sender + template
  scheduler.js             # cron jobs + rate limiting
  server.js                # express API + dashboard
public/
  index.html               # dashboard UI
```
