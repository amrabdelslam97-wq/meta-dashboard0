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
 * True if a caught error is a Meta rate-limit failure (after metaGet()'s own
 * internal retries were exhausted) -- the single source of truth for this
 * check, since this module is what tags errors with .isRateLimit/.isMetaError/
 * .code in the first place. New callers (e.g. analyticsEngine.js) should use
 * this rather than re-deriving their own copy of RATE_LIMIT_ERROR_CODES.
 */
function isRateLimitError(err) {
  if (!err) return false;
  if (err.isRateLimit) return true;
  if (err.isMetaError && isRateLimitErrorCode(err.code)) return true;
  return false;
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
      // effective_status is the REAL delivery state (accounts for ad
      // review/policy/billing/account-level restrictions on top of this
      // campaign's own status) -- status alone is not enough to know
      // whether this campaign is actually delivering right now.
      fields: 'id,name,objective,status,effective_status,created_time,updated_time',
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
      // optimization_goal powers the Video Views KPI sub-profile
      // (kpiProfileResolver.resolveProfile) and the Optimization Goal
      // filter -- no separate API call needed, this endpoint already
      // returns it once requested in `fields`. effective_status: see
      // fetchCampaigns()'s comment -- an ad set can be status=ACTIVE while
      // effective_status=CAMPAIGN_PAUSED (its parent campaign is paused).
      // targeting{...} -- real Meta AdSet targeting fields, added to this
      // SAME existing call (zero new Meta requests). Sub-fields requested as
      // PLAIN names within targeting{}, never further nested -- confirmed
      // via a real production bug (metaApiClient.js's fetchAdCreativeDetail()
      // asset_feed_spec{id} request) that guessing a *second* level of `{}`
      // sub-field expansion on a JSON-blob-shaped field reliably 400s with
      // "(#100) Tried accessing nonexisting field"; only `targeting{locales}`
      // (one level) was ever confirmed against a real account, so every new
      // field below stays at that same one level and is parsed defensively
      // (extractAudienceSignals() in syncService.js never assumes a shape
      // Meta didn't actually return):
      //   locales -- Language Analytics' configuration view (Phase 17).
      //   custom_audiences / excluded_custom_audiences / lookalike_spec /
      //     flexible_spec / geo_locations / targeting_automation --
      //     Attribution & Customer Journey Intelligence's audience-type
      //     classification (Step 9). custom_audiences' referenced audience
      //     IDs are resolved to their real subtype (CUSTOM/WEBSITE/
      //     ENGAGEMENT/APP/LOOKALIKE) via a separate, ACCOUNT-level (not
      //     per-ad-set) fetchCustomAudiences() call, cached and joined by id
      //     -- that subtype is NOT a property of the ad set's own targeting.
      //   targeting_automation.advantage_audience -- real Meta field marking
      //     Advantage+ Audience; without it, an Advantage+ ad set would be
      //     indistinguishable from a broad one.
      fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,created_time,updated_time,optimization_goal,' +
              'targeting{locales,custom_audiences,excluded_custom_audiences,lookalike_spec,flexible_spec,geo_locations,targeting_automation}',
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
      // effective_status: see fetchCampaigns()'s comment -- an ad can be
      // status=ACTIVE while effective_status=ADSET_PAUSED/CAMPAIGN_PAUSED
      // (a parent is paused), or DISAPPROVED/PENDING_REVIEW/WITH_ISSUES
      // (Meta's ad review pipeline), none of which mean it's delivering.
      // destination_type -- real Meta Ad field (MESSENGER, WHATSAPP,
      // INSTAGRAM_DIRECT, ON_AD, ...), added for Messaging Destination
      // Analytics (Executive Marketing Analytics Layer, Phase 17).
      fields: 'id,name,status,effective_status,created_time,updated_time,destination_type,creative{id,thumbnail_url,image_url}',
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
 * Fetch full creative detail for one ad -- headline/primary text/description/
 * CTA/video, none of which are part of the Insights API (metricsFetcher.js's
 * fetchAdMetrics() covers performance; this covers creative content). Used
 * by creativeAnalytics.js (Executive Marketing Analytics Layer).
 *
 * object_story_spec is the real Meta AdCreative field that carries these --
 * shaped differently for a link/image ad (link_data) vs. a video ad
 * (video_data), so both are checked; neither fabricated when absent (e.g.
 * very old boosted-post creatives Meta doesn't expose full spec for).
 *
 * @param {string} metaAdId
 * @param {string} accessToken
 * @returns {object} raw creative fields (id, name, object_type, video_id,
 *   image_url, thumbnail_url, object_story_spec)
 */
async function fetchAdCreativeDetail(metaAdId, accessToken) {
  const response = await metaGet(
    `${metaAdId}`,
    {
      // image_hash (Creative Intelligence Engine, Executive Marketing
      // Analytics Layer follow-on): Meta's real AdCreative field
      // identifying the underlying media asset, used to detect the same
      // creative reused across multiple ads (dedup for the Creative
      // Library, Step 11/12) without a second Meta call. link_data.link /
      // video_data.call_to_action.value.link are the real fields carrying
      // the ad's destination URL -- neither is part of object_story_spec's
      // top level, both must be requested explicitly like any nested field.
      // asset_feed_spec is requested only to detect its PRESENCE -- Dynamic
      // Creative / Advantage+ creatives use asset_feed_spec instead of a
      // single object_story_spec. Requested as a plain field, not
      // `asset_feed_spec{id}` -- confirmed via live Meta API verification
      // that asset_feed_spec does not support `{id}` sub-field expansion
      // (Meta returns "(#100) Tried accessing nonexisting field (id)"); the
      // plain field already returns its full object when present, or is
      // simply absent from the response otherwise -- exactly the
      // presence/absence signal this needs, no extra request shape required.
      fields: 'creative{id,name,object_type,video_id,image_url,image_hash,thumbnail_url,' +
              'object_story_spec{link_data{link,call_to_action{type,value}},video_data{call_to_action{type,value}}},' +
              'asset_feed_spec}',
    },
    accessToken
  );
  return response?.creative || null;
}

/**
 * Fetch a video's real length (seconds) -- Meta's Video object, not part of
 * Insights or AdCreative. Called only for ads whose creative has a video_id
 * (Creative Intelligence Engine's "Video Length" field, Step 1) -- one call
 * per distinct video, and only for creatives not yet detailed (same
 * checkpoint discipline as fetchAdCreativeDetail's caller).
 *
 * @param {string} videoId
 * @param {string} accessToken
 * @returns {number|null} length in seconds, or null if Meta doesn't report it
 */
async function fetchVideoDetail(videoId, accessToken) {
  const response = await metaGet(`${videoId}`, { fields: 'length' }, accessToken);
  const length = parseFloat(response?.length);
  return Number.isNaN(length) ? null : length;
}

/**
 * Fetch every Custom Audience defined on an ad account, with its real
 * `subtype` (CUSTOM, WEBSITE, ENGAGEMENT, APP, LOOKALIKE, ...) -- Attribution
 * & Customer Journey Intelligence's audience-type classification (Step 9).
 * This is the ONE piece of audience-type signal that genuinely cannot come
 * from an ad set's own `targeting.custom_audiences` (which only ever
 * returns each referenced audience's `id`, never its subtype): fetched ONCE
 * per account, not once per ad set, and cached/joined by id by the caller
 * (audienceAttributionEngine.js) -- an O(1)-per-account call, not O(n)
 * per-ad-set, consistent with this system's "no unnecessary Meta calls" rule.
 *
 * @param {string} metaAccountId - e.g. act_123456
 * @param {string} accessToken
 * @returns {Array<{id:string, name:string, subtype:string|null}>}
 */
async function fetchCustomAudiences(metaAccountId, accessToken) {
  const audiences = await metaGetAll(
    `${metaAccountId}/customaudiences`,
    { fields: 'id,name,subtype', limit: 100 },
    accessToken
  );
  return audiences;
}

module.exports = {
  fetchCampaigns,
  fetchAdSets,
  fetchAds,
  fetchAdPreview,
  fetchVideoDetail,
  fetchAdCreativeDetail,
  fetchCustomAudiences,
  metaGet,
  metaGetAll,
  isRateLimitError,
};
