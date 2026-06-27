const axios = require('axios');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Nominatim usage policy requires a descriptive User-Agent and max 1 req/sec
const HEADERS = { 'User-Agent': 'LeadHunterBot/1.0 (personal lead-gen tool)' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Maps the niche names used in .env (same names as Google Places types, for compatibility)
// to OSM tag queries. Add more here if you add more niches.
const NICHE_TO_OSM_TAG = {
  // Restaurants & Food
  restaurant: '["amenity"="restaurant"]',
  restaurants: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  'coffee shop': '["amenity"="cafe"]',
  'fast food': '["amenity"="fast_food"]',
  'pizza restaurant': '["amenity"="restaurant"]',
  'burger restaurant': '["amenity"="restaurant"]',
  'BBQ restaurant': '["amenity"="restaurant"]',
  steakhouse: '["amenity"="restaurant"]',
  'seafood restaurant': '["amenity"="restaurant"]',
  'family restaurant': '["amenity"="restaurant"]',
  'fine dining': '["amenity"="restaurant"]',
  'food court': '["amenity"="fast_food"]',
  bakery: '["shop"="bakery"]',
  'dessert shop': '["shop"="confectionery"]',
  'ice cream shop': '["amenity"="ice_cream"]',
  'juice bar': '["amenity"="juice_bar"]',
  'tea house': '["amenity"="tea_house"]',
  bistro: '["amenity"="restaurant"]',

  // Clinics & Medical
  clinic: '["amenity"="clinic"]',
  'medical clinic': '["amenity"="clinic"]',
  'health clinic': '["amenity"="clinic"]',
  'family clinic': '["amenity"="clinic"]',
  'dental clinic': '["amenity"="dentist"]',
  'skin clinic': '["amenity"="clinic"]',
  'dermatology clinic': '["amenity"="clinic"]',
  'physiotherapy clinic': '["amenity"="physiotherapist"]',
  'eye clinic': '["amenity"="clinic"]',
  'ENT clinic': '["amenity"="clinic"]',
  'orthopedic clinic': '["amenity"="clinic"]',
  'children clinic': '["amenity"="clinic"]',
  'women health clinic': '["amenity"="clinic"]',
  'diagnostic center': '["amenity"="clinic"]',
  laboratory: '["amenity"="laboratory"]',
  'urgent care': '["amenity"="clinic"]',
  'medical center': '["amenity"="clinic"]',

  // Gyms & Fitness
  gym: '["leisure"="fitness_centre"]',
  'fitness center': '["leisure"="fitness_centre"]',
  'fitness club': '["leisure"="fitness_centre"]',
  'health club': '["leisure"="fitness_centre"]',
  'CrossFit gym': '["leisure"="fitness_centre"]',
  'personal training': '["leisure"="fitness_centre"]',
  'boxing gym': '["leisure"="fitness_centre"]',
  'martial arts academy': '["leisure"="sports_centre"]',
  'yoga studio': '["leisure"="fitness_centre"]',
  'Pilates studio': '["leisure"="fitness_centre"]',
  'sports club': '["leisure"="sports_centre"]',
  'strength training': '["leisure"="fitness_centre"]',
  'fitness studio': '["leisure"="fitness_centre"]',
  'bodybuilding gym': '["leisure"="fitness_centre"]',

  // Pharmacies
  pharmacy: '["amenity"="pharmacy"]',
  'medical store': '["amenity"="pharmacy"]',
  chemist: '["amenity"="pharmacy"]',
  'drug store': '["amenity"="pharmacy"]',
  'medicine shop': '["amenity"="pharmacy"]',
  'health pharmacy': '["amenity"="pharmacy"]',
  'retail pharmacy': '["amenity"="pharmacy"]',
  'community pharmacy': '["amenity"="pharmacy"]',
  'hospital pharmacy': '["amenity"="pharmacy"]',

  // Other existing
  real_estate_agency: '["office"="estate_agent"]',
  clothing_store: '["shop"="clothes"]',
  school: '["amenity"="school"]',
  electronics_store: '["shop"="electronics"]',
  hotel: '["tourism"="hotel"]',
  supermarket: '["shop"="supermarket"]'
};

async function geocodeCity(city) {
  const { data } = await axios.get(NOMINATIM_URL, {
    params: { q: city, format: 'json', limit: 1 },
    headers: HEADERS
  });
  if (!data || data.length === 0) throw new Error(`Could not geocode city: ${city}`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

function toWhatsAppFormat(phone) {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = '92' + digits.slice(1);
  if (!digits.startsWith('92') && digits.length === 10) digits = '92' + digits;
  return digits;
}

function buildAddress(tags) {
  const parts = [tags['addr:street'], tags['addr:city'] || tags['addr:suburb']].filter(Boolean);
  return parts.join(', ') || null;
}

async function queryOverpass(lat, lon, radiusMeters, osmTagFilter, retries = 5) {
  const query = `
    [out:json][timeout:25];
    (
      node(around:${radiusMeters},${lat},${lon})${osmTagFilter};
      way(around:${radiusMeters},${lat},${lon})${osmTagFilter};
    );
    out center tags;
  `;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
        headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 45000
      });
      return data.elements || [];
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 504 || status === 502 || status === 503 || !status;

      if (attempt === retries || !isRetryable) {
        throw err;
      }

      const backoffMs = Math.min(5000 * Math.pow(2, attempt), 60000);
      console.log(`[osm] Overpass query failed (status ${status || 'network'}), retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries + 1})...`);
      await sleep(backoffMs);
    }
  }
}

/**
 * Free local business lead scraper using OpenStreetMap data.
 * No API key, no billing - but contact info (phone/website) coverage is lower than
 * Google Places, especially in smaller cities. enrich.js will still try to find
 * emails from any website tag that IS present.
 */
async function fetchLocalLeadsOSM({ cities, niches, radiusMeters = 6000 }) {
  const leads = [];

  for (const city of cities) {
    let coords;
    try {
      coords = await geocodeCity(city);
      await sleep(1100); // Nominatim rate limit: max 1 req/sec
    } catch (err) {
      console.error(`[osm] Geocode failed for "${city}":`, err.message);
      continue;
    }

    for (const niche of niches) {
      const tagFilter = NICHE_TO_OSM_TAG[niche];
      if (!tagFilter) {
        console.warn(`[osm] No OSM tag mapping for niche "${niche}" - skipping. Add it to NICHE_TO_OSM_TAG in osm.js.`);
        continue;
      }

      try {
        const elements = await queryOverpass(coords.lat, coords.lon, radiusMeters, tagFilter);

        for (const el of elements) {
          const tags = el.tags || {};
          if (!tags.name) continue; // skip unnamed nodes, not useful as leads

          // Try multiple phone/email fields
          const phone = tags.phone || tags['contact:phone'] || tags.mobile || tags['contact:mobile'] || null;
          const website = tags.website || tags['contact:website'] || tags.url || null;
          const email = tags.email || tags['contact:email'] || null;

          leads.push({
            source: 'osm',
            category: niche,
            name: tags.name,
            city,
            phone,
            whatsapp: toWhatsAppFormat(phone),
            email,
            website,
            job_url: null,
            notes: buildAddress(tags),
            contactable: !!(phone || email || website) // only mark contactable if has some contact info
          });
        }

        const delayMs = Number(process.env.OSM_QUERY_DELAY_MS) || 8000;
        await sleep(delayMs); // be polite to the free Overpass public instance
      } catch (err) {
        console.error(`[osm] Overpass query failed for ${niche} in ${city}:`, err.message);
      }
    }
  }

  return leads;
}

module.exports = { fetchLocalLeadsOSM };
