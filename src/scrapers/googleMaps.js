const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchPlaces(query) {
  const results = [];
  let pageToken = null;
  let pages = 0;

  do {
    const params = { query, key: API_KEY };
    if (pageToken) params.pagetoken = pageToken;

    const { data } = await axios.get(TEXT_SEARCH_URL, { params });
    if (data.results) results.push(...data.results);
    pageToken = data.next_page_token;
    pages++;
    if (pageToken) await sleep(2200); // Google requires a short delay before next_page_token is valid
  } while (pageToken && pages < 3); // max 60 results per query, keeps cost sane

  return results;
}

async function getDetails(placeId) {
  const params = {
    place_id: placeId,
    fields: 'name,formatted_phone_number,international_phone_number,website,formatted_address',
    key: API_KEY
  };
  const { data } = await axios.get(DETAILS_URL, { params });
  return data.result || {};
}

function toWhatsAppFormat(phone) {
  if (!phone) return null;
  // strip everything except digits, assume Pakistan +92 if starts with 0
  let digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = '92' + digits.slice(1);
  if (!digits.startsWith('92') && digits.length === 10) digits = '92' + digits;
  return digits;
}

/**
 * Fetches local business leads for given cities + niches.
 * Returns array of normalized lead objects (not yet inserted into DB).
 */
async function fetchLocalLeads({ cities, niches }) {
  if (!API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY missing in .env — get one from Google Cloud Console.');
  }

  const leads = [];

  for (const city of cities) {
    for (const niche of niches) {
      const query = `${niche.replace(/_/g, ' ')} in ${city}`;
      try {
        const places = await searchPlaces(query);
        for (const place of places.slice(0, 15)) { // cap per query to control API cost
          const details = await getDetails(place.place_id);
          const phone = details.international_phone_number || details.formatted_phone_number || null;

          leads.push({
            source: 'google_maps',
            category: niche,
            name: details.name || place.name,
            city,
            phone,
            whatsapp: toWhatsAppFormat(phone),
            email: null, // filled later by enrich.js if website exists
            website: details.website || null,
            job_url: null,
            notes: details.formatted_address || place.formatted_address || null,
            contactable: true
          });
          await sleep(300); // be gentle on API quota
        }
      } catch (err) {
        console.error(`[googleMaps] Failed for "${query}":`, err.message);
      }
    }
  }

  return leads;
}

module.exports = { fetchLocalLeads };
