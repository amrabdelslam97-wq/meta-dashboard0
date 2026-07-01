/**
 * Meta API Client
 *
 * Handles all communication with the Meta Marketing API.
 * - Manages pagination automatically
 * - Handles rate limiting with exponential backoff across both HTTP 429
 *   and Meta's own rate-limit error codes (which frequently arrive as
 *   HTTP 400 with a specific error.code, not HTTP 429)
 * - Returns normalized raw responses — no business logic here
 */

const axios = require('axios');

const META_API_BASE = 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v21.0';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5_000; // exponential: 5s, 10s, 20s

// Meta's standard rate-limit/throttling error codes. These commonly arrive
// as HTTP 400 (or 200 with an error body), not HTTP 429, so relying on the
// HTTP status alone misses most real-world throttling responses:
//   4   - Application request limit reached
//   17  - User request limit reached
//   32  - Page request limit reached
//   613 - Calls to this API have exceeded the rate limit
//   80000-80014 - Ads Insights / ad-account-level rate limiting
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);

function isRateLimitErrorCode(code) {
  return RATE_LIMIT_ERROR_CODES.has(code) || (code >= 80000 && code <= 80014);
}

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
 * @param {number} attempt - Internal retry counter, starts at 0
 */
async function metaGet(endpoint, params = {}, accessToken, attempt = 0) {
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
    const status = err.response?.status;
    const metaError = err.response?.data?.error;
    const isRateLimited = status === 429 || (metaError && isRateLimitErrorCode(metaError.code));

    if (isRateLimited && attempt < MAX_RETRIES) {
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[Meta API] Rate limited (${status ?? 'no status'}${metaError ? `, code=${metaError.code}` : ''}) — ` +
        `retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s...`
      );
      await sleep(delay);
      return metaGet(endpoint, params, accessToken, attempt + 1);
    }

    // Build a descriptive error
    if (metaError) {
      const error = new Error(metaError.message || 'Meta API error');
      error.code = metaError.code;
      error.type = metaError.type;
      error.httpStatus = status;
      error.isMetaError = true;
      error.isRateLimit = isRateLimited;
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
 * The returned array carries two extra (non-enumerable-breaking, but not
 * part of a normal array) properties so existing callers that just treat
 * the result as a plain array keep working unchanged, while callers that
 * care can check them:
 *   .incomplete       - true if the safety limit was hit or a page fetch
 *                        failed mid-stream (i.e. this is NOT the full set)
 *   .incompleteReason - 'safety_limit' | 'page_fetch_error' | undefined
 *
 * @param {string} endpoint
 * @param {object} params - Initial query params
 * @param {string} accessToken
 * @returns {Array} All records across all pages (see above for flags)
 */
async function metaGetAll(endpoint, params = {}, accessToken) {
  const allItems = [];
  allItems.incomplete = false;

  // First request
  let response = await metaGet(endpoint, params, accessToken);

  if (response.data) {
    allItems.push(...response.data);
  }

  // Meta's documented guidance is to key "are there more pages" off the
  // presence of paging.next, not cursors.after -- the after cursor can be
  // present without more results actually existing. cursors.after is still
  // used as the request parameter when available (cheaper than following
  // a full URL), but paging.next is the loop's actual continuation signal.
  while (response.paging?.next) {
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
        allItems.incomplete = true;
        allItems.incompleteReason = 'page_fetch_error';
        break;
      }
    }

    if (response.data) {
      allItems.push(...response.data);
    }

    // Safety limit — Meta campaigns shouldn't exceed this in practice
    if (allItems.length >= 5000) {
      console.warn('[Meta API] Pagination safety limit reached at 5000 items');
      allItems.incomplete = true;
      allItems.incompleteReason = 'safety_limit';
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
