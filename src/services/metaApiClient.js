/**
 * Meta API Client
 *
 * Handles all communication with the Meta Marketing API.
 * - Manages pagination automatically
 * - Handles rate limit responses (HTTP 429) with one retry
 * - Returns normalized raw responses — no business logic here
 */

const axios = require('axios');

const META_API_BASE = 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v21.0';
const RATE_LIMIT_RETRY_DELAY_MS = 60_000; // 60 seconds on 429

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make a single GET request to the Meta Graph API.
 * Returns the parsed JSON response body.
 *
 * @param {string} endpoint - Path after /vX.X/ e.g. "act_123/campaigns"
 * @param {object} params - Query parameters
 * @param {string} accessToken - Meta access token
 * @param {boolean} isRetry - Whether this is a retry after rate limit
 */
async function metaGet(endpoint, params = {}, accessToken, isRetry = false) {
  const url = `${META_API_BASE}/${API_VERSION}/${endpoint}`;

  try {
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        ...params,
      },
      timeout: 30_000,
    });

    return response.data;

  } catch (err) {
    // Rate limit: wait 60s and retry once
    if (err.response?.status === 429 && !isRetry) {
      console.warn('[Meta API] Rate limit hit — waiting 60 seconds before retry...');
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      return metaGet(endpoint, params, accessToken, true);
    }

    // Build a descriptive error
    const status = err.response?.status;
    const metaError = err.response?.data?.error;

    if (metaError) {
      const error = new Error(metaError.message || 'Meta API error');
      error.code = metaError.code;
      error.type = metaError.type;
      error.httpStatus = status;
      error.isMetaError = true;
      throw error;
    }

    if (err.code === 'ECONNABORTED') {
      const error = new Error('Meta API request timed out');
      error.isTimeout = true;
      throw error;
    }

    throw err;
  }
}

/**
 * Fetch all pages of a paginated Meta API response.
 * Follows the cursor-based pagination Meta uses.
 *
 * @param {string} endpoint
 * @param {object} params - Initial query params
 * @param {string} accessToken
 * @returns {Array} All records across all pages
 */
async function metaGetAll(endpoint, params = {}, accessToken) {
  const allItems = [];
  let nextUrl = null;

  // First request
  let response = await metaGet(endpoint, params, accessToken);

  if (response.data) {
    allItems.push(...response.data);
  }

  // Follow pagination cursors
  while (response.paging?.cursors?.after || response.paging?.next) {
    const after = response.paging?.cursors?.after;

    if (after) {
      response = await metaGet(endpoint, { ...params, after }, accessToken);
    } else {
      // Use next URL directly (Meta sometimes returns full next URL)
      try {
        const nextResponse = await axios.get(response.paging.next, { timeout: 30_000 });
        response = nextResponse.data;
      } catch (err) {
        console.error('[Meta API] Pagination error:', err.message);
        break;
      }
    }

    if (response.data) {
      allItems.push(...response.data);
    }

    // Safety limit — Meta campaigns shouldn't exceed this in practice
    if (allItems.length >= 5000) {
      console.warn('[Meta API] Pagination safety limit reached at 5000 items');
      break;
    }
  }

  return allItems;
}

/**
 * Fetch all campaigns for a given Meta ad account.
 *
 * @param {string} metaAccountId - Meta account ID (e.g. act_123456)
 * @param {string} accessToken
 * @returns {Array} Raw campaign objects from Meta
 */
async function fetchCampaigns(metaAccountId, accessToken) {
  console.log(`[Meta API] Fetching campaigns for account ${metaAccountId}...`);

  const campaigns = await metaGetAll(
    `${metaAccountId}/campaigns`,
    {
      fields: 'id,name,objective,status,created_time,updated_time',
      limit: 100,
    },
    accessToken
  );

  console.log(`[Meta API] Fetched ${campaigns.length} campaigns for ${metaAccountId}`);
  return campaigns;
}

/**
 * Fetch all ad sets for a given Meta campaign.
 *
 * @param {string} metaCampaignId
 * @param {string} accessToken
 * @returns {Array} Raw ad set objects from Meta
 */
async function fetchAdSets(metaCampaignId, accessToken) {
  const adSets = await metaGetAll(
    `${metaCampaignId}/adsets`,
    {
      fields: 'id,name,status,daily_budget,lifetime_budget,created_time,updated_time',
      limit: 100,
    },
    accessToken
  );

  return adSets;
}

/**
 * Fetch all ads for a given Meta ad set.
 *
 * @param {string} metaAdSetId
 * @param {string} accessToken
 * @returns {Array} Raw ad objects from Meta
 */
async function fetchAds(metaAdSetId, accessToken) {
  const ads = await metaGetAll(
    `${metaAdSetId}/ads`,
    {
      // creative{...} requests the AdCreative sub-object inline on the same
      // call -- no extra request needed for id/thumbnail_url/image_url.
      fields: 'id,name,status,created_time,updated_time,creative{id,thumbnail_url,image_url}',
      limit: 100,
    },
    accessToken
  );

  return ads;
}

/**
 * Fetch a rendered ad preview for one ad.
 *
 * Meta's Ad Previews endpoint (GET /{ad_id}/previews) does not return a
 * plain preview URL -- it returns an HTML snippet containing an <iframe>
 * whose src attribute is the actual preview URL. This extracts that URL
 * from the real response rather than fabricating one; if Meta's response
 * shape ever changes such that no iframe src can be found, this returns
 * null instead of guessing.
 *
 * @param {string} metaAdId
 * @param {string} accessToken
 * @param {string} adFormat - one of Meta's supported ad_format values,
 *   e.g. DESKTOP_FEED_STANDARD, MOBILE_FEED_STANDARD, INSTAGRAM_STANDARD
 * @returns {string|null} the extracted iframe src URL, or null
 */
async function fetchAdPreview(metaAdId, accessToken, adFormat = 'DESKTOP_FEED_STANDARD') {
  const response = await metaGet(
    `${metaAdId}/previews`,
    { ad_format: adFormat },
    accessToken
  );

  const body = response?.data?.[0]?.body;
  if (!body) return null;

  const match = body.match(/src="([^"]+)"/);
  return match ? match[1].replace(/&amp;/g, '&') : null;
}

/**
 * Verify that a Meta access token is valid by calling /me.
 * Returns basic account info on success, throws on failure.
 *
 * @param {string} accessToken
 */
async function verifyToken(accessToken) {
  const response = await metaGet('me', { fields: 'id,name' }, accessToken);
  return response;
}

module.exports = {
  fetchCampaigns,
  fetchAdSets,
  fetchAds,
  fetchAdPreview,
  verifyToken,
  metaGet,
  metaGetAll,
};
