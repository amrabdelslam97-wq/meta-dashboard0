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
const NETWORK_MAX_RETRIES = 2; // separate, shorter budget for plain connectivity failures
const NETWORK_RETRY_DELAY_MS = 2_000;

// Meta's standard rate-limit/throttling error codes. These commonly arrive
// as HTTP 400 (or 200 with an error body), not HTTP 429, so relying on the
// HTTP status alone misses most real-world throttling responses:
//   4   - Application request limit reached
//   17  - User request limit reached
//   32  - Page request limit reached
//   613 - Calls to this API have exceeded the rate limit
//   80000-80014 - Ads Insights / ad-account-level rate limiting
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);

// Error Classification (Phase 39, requirement 14) -- each category gets its
// own retry strategy in metaGet() below:
//   rate limit  -> retry with exponential backoff (existing behavior)
//   network     -> retry a short, fixed number of times (transient)
//   auth        -> never retry (a bad/expired token won't fix itself);
//                  callers (syncService.js) mark the account token_is_valid=0
//   permission  -> never retry (a permission grant won't appear mid-request)
//   validation  -> never retry (a malformed request stays malformed)
const AUTH_ERROR_CODES = new Set([190, 102, 2500]); // OAuthException / expired or invalid session
const PERMISSION_ERROR_CODES = new Set([10, 200]); // "Application does not have permission" family
const VALIDATION_ERROR_CODES = new Set([100, 2635]); // invalid parameter / deprecated API call

// Real Node/libuv connectivity error codes only -- deliberately NOT "any
// error with no err.response", which also matches things that are not
// transient network failures at all (a request that was never sent due to
// a client-side bug, or -- concretely, caught in this project's own test
// suite -- an HTTP mocking library rejecting an unmatched request). Scoping
// the retry to this known-transient set keeps "network errors get a short
// retry" from silently absorbing several real seconds of delay on errors
// that were never going to resolve by waiting.
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']);

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

/** True if a caught error is an auth/expired-token failure (Meta code 190/102/2500 or type OAuthException). */
function isAuthError(err) {
  if (!err) return false;
  return !!err.isAuthError;
}

/** True if a caught error is a plain connectivity failure (no HTTP response at all, not a timeout). */
function isNetworkError(err) {
  if (!err) return false;
  return !!err.isNetworkError;
}

function classifyMetaError(metaError) {
  const isAuth = metaError.type === 'OAuthException' || AUTH_ERROR_CODES.has(metaError.code);
  const isPermission = !isAuth && (PERMISSION_ERROR_CODES.has(metaError.code) || /permission/i.test(metaError.message || ''));
  const isValidation = !isAuth && !isPermission && (VALIDATION_ERROR_CODES.has(metaError.code) || metaError.type === 'GraphMethodException');
  return { isAuth, isPermission, isValidation };
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// Adaptive Delay (Phase 39, requirement 8)
//
// Accounts are always synced strictly sequentially -- syncService.
// syncAllAccounts() and autoSyncScheduler's queue never run two accounts'
// worth of Meta calls concurrently (Smart Account Queue, requirement 7) --
// so a single process-wide pacing level accurately reflects "how hard is
// Meta currently throttling whichever account we're mid-sync for" without
// threading an accountId through every metaGet() call site across
// metricsFetcher.js, syncService.js, smartSyncEngine.js, analyticsEngine.js,
// creativeAnalytics.js, etc.
//
// Two independent signals feed the level:
//   1. An actual rate-limit response (proven throttling).
//   2. Meta's own proactive usage headers (X-Business-Use-Case-Usage /
//      X-App-Usage / X-Ad-Account-Usage), which report a 0-100 utilization
//      percentage BEFORE Meta ever rejects a request -- reacting to these
//      lets this app slow down pre-emptively instead of only after getting
//      throttled.
//
// Disabled under the test runner (same precedent as app.js's rate limiters
// and autoSyncScheduler only starting from the real server) -- otherwise
// every one of the hundreds of metaGet() calls across the Jest suite would
// pick up a minimum 200ms delay, adding minutes to CI for zero signal value
// against nock-mocked responses that never carry real usage headers anyway.
// ─────────────────────────────────────────────
const ADAPTIVE_DELAY_ENABLED = process.env.NODE_ENV !== 'test';
const DELAY_LEVELS = { none: 200, light: 500, heavy: 1000, repeated: 3000 };
const DELAY_ORDER = ['none', 'light', 'heavy', 'repeated'];

let currentDelayLevel = 'none';
let consecutiveThrottleSignals = 0;
let consecutiveCleanSignals = 0;

function escalate(toAtLeast) {
  const currentIdx = DELAY_ORDER.indexOf(currentDelayLevel);
  const targetIdx = DELAY_ORDER.indexOf(toAtLeast);
  if (targetIdx > currentIdx) currentDelayLevel = toAtLeast;
}

function recordThrottleSignal() {
  consecutiveCleanSignals = 0;
  consecutiveThrottleSignals++;
  if (consecutiveThrottleSignals >= 3) currentDelayLevel = 'repeated';
  else if (consecutiveThrottleSignals >= 2) escalate('heavy');
  else escalate('light');
}

function recordCleanSignal() {
  consecutiveThrottleSignals = 0;
  consecutiveCleanSignals++;
  // Recover gradually -- several clean calls in a row step the delay back
  // down one level at a time rather than snapping straight to 'none', so a
  // single lucky request doesn't immediately undo real, recently-observed
  // backoff pressure.
  if (consecutiveCleanSignals >= 10) {
    const idx = DELAY_ORDER.indexOf(currentDelayLevel);
    if (idx > 0) currentDelayLevel = DELAY_ORDER[idx - 1];
    consecutiveCleanSignals = 0;
  }
}

/**
 * Meta's Business Use Case / App / Ad Account usage headers are a
 * JSON-encoded map of { call_count, total_cputime, total_time } (each a
 * 0-100 utilization percentage) per app/business-id. Returns the highest
 * percentage found, or null if no usage header is present (older API
 * versions / some endpoints don't send one).
 */
function inspectUsageHeaders(headers) {
  if (!headers) return null;
  const raw = headers['x-business-use-case-usage'] || headers['x-app-usage'] || headers['x-ad-account-usage'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const buckets = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
    let maxPct = 0;
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      maxPct = Math.max(maxPct, bucket.call_count || 0, bucket.total_cputime || 0, bucket.total_time || 0);
    }
    return maxPct;
  } catch {
    return null;
  }
}

function recordUsageSignal(headers) {
  const pct = inspectUsageHeaders(headers);
  if (pct === null) {
    recordCleanSignal();
    return;
  }
  if (pct >= 90) recordThrottleSignal();
  else if (pct >= 75) escalate('light');
  else recordCleanSignal();
}

function getAdaptiveDelayMs() {
  if (!ADAPTIVE_DELAY_ENABLED) return 0;
  return DELAY_LEVELS[currentDelayLevel];
}

/** Test/debug helper -- current pacing level and delay. */
function getPacingStatus() {
  return { level: currentDelayLevel, delay_ms: DELAY_LEVELS[currentDelayLevel] };
}

/** Test-only reset so pacing state doesn't leak escalation across test files. */
function resetPacing() {
  currentDelayLevel = 'none';
  consecutiveThrottleSignals = 0;
  consecutiveCleanSignals = 0;
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

  const delay = getAdaptiveDelayMs();
  if (delay > 0) await sleep(delay);

  try {
    const response = await axios.get(url, {
      params: {
        access_token: accessToken,
        ...params,
      },
      timeout: 30_000,
    });

    recordUsageSignal(response.headers);
    return response.data;

  } catch (err) {
    const status = err.response?.status;
    const metaError = err.response?.data?.error;
    const isRateLimited = status === 429 || (metaError && isRateLimitErrorCode(metaError.code));

    if (isRateLimited && attempt < MAX_RETRIES) {
      recordThrottleSignal();
      const backoff = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[Meta API] Rate limited (${status ?? 'no status'}${metaError ? `, code=${metaError.code}` : ''}) — ` +
        `retry ${attempt + 1}/${MAX_RETRIES} in ${backoff / 1000}s...`
      );
      await sleep(backoff);
      return metaGet(endpoint, params, accessToken, attempt + 1);
    }

    // Build a descriptive, classified error (Error Classification, requirement 14).
    if (metaError) {
      const cls = classifyMetaError(metaError);
      const error = new Error(metaError.message || 'Meta API error');
      error.code = metaError.code;
      error.type = metaError.type;
      error.httpStatus = status;
      error.isMetaError = true;
      error.isRateLimit = isRateLimited;
      error.isAuthError = cls.isAuth;
      error.isPermissionError = cls.isPermission;
      error.isValidationError = cls.isValidation;
      throw error;
    }

    if (err.code === 'ECONNABORTED') {
      const error = new Error('Meta API request timed out');
      error.isTimeout = true;
      throw error;
    }

    // Plain connectivity failure (DNS, connection refused/reset, etc.) --
    // no HTTP response at all AND a recognized transient network error
    // code (see NETWORK_ERROR_CODES' comment for why this is scoped this
    // narrowly). Distinct, short retry budget: unlike a rate limit (which
    // needs Meta-side cooldown) or an auth/permission/validation error
    // (which will never succeed on retry), a transient network blip often
    // clears within a couple of seconds.
    if (!err.response && NETWORK_ERROR_CODES.has(err.code)) {
      if (attempt < NETWORK_MAX_RETRIES) {
        console.warn(`[Meta API] Network error (${err.code || err.message}) — retry ${attempt + 1}/${NETWORK_MAX_RETRIES} in ${NETWORK_RETRY_DELAY_MS / 1000}s...`);
        await sleep(NETWORK_RETRY_DELAY_MS * (attempt + 1));
        return metaGet(endpoint, params, accessToken, attempt + 1);
      }
      const error = new Error(err.message || 'Meta API network error');
      error.isNetworkError = true;
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
 * Meta's `filtering` query param -- an array of {field, operator, value}
 * predicates evaluated server-side, so filtered-out objects never cross the
 * wire at all (cheaper than fetching everything and discarding client-side).
 * Used by fetchCampaigns/fetchAdSets/fetchAds' `activeOnly` option (Phase 39,
 * requirement 1 -- scheduled/incremental sync sees only ACTIVE objects
 * unless a Full Sync explicitly asks for everything).
 */
function buildEffectiveStatusFilter(statuses) {
  return JSON.stringify([{ field: 'effective_status', operator: 'IN', value: statuses }]);
}

/**
 * Fetch campaigns for a given Meta ad account.
 *
 * @param {string} metaAccountId - Meta account ID (e.g. act_123456)
 * @param {string} accessToken
 * @param {object} [options]
 * @param {boolean} [options.activeOnly] - when true, Meta filters server-side
 *   to effective_status=ACTIVE only (Full Sync must pass false/omit to see
 *   paused/archived campaigns too -- never deletes what's already stored,
 *   just doesn't re-request it on an incremental pass).
 * @returns {Array} Raw campaign objects from Meta
 */
async function fetchCampaigns(metaAccountId, accessToken, options = {}) {
  const { activeOnly = false } = options;
  console.log(`[Meta API] Fetching ${activeOnly ? 'ACTIVE ' : ''}campaigns for account ${metaAccountId}...`);

  const params = {
    // effective_status is the REAL delivery state (accounts for ad
    // review/policy/billing/account-level restrictions on top of this
    // campaign's own status) -- status alone is not enough to know
    // whether this campaign is actually delivering right now.
    fields: 'id,name,objective,status,effective_status,created_time,updated_time',
    limit: 100,
  };
  if (activeOnly) params.filtering = buildEffectiveStatusFilter(['ACTIVE']);

  const campaigns = await metaGetAll(`${metaAccountId}/campaigns`, params, accessToken);

  console.log(`[Meta API] Fetched ${campaigns.length} campaigns for ${metaAccountId}`);
  return campaigns;
}

/**
 * Extract the field name Meta's "(#100) Tried accessing nonexisting field
 * (X)" error refers to, if present. Returns null for any other error shape.
 */
function extractNonexistingField(message) {
  const match = /Tried accessing nonexisting field \(([^)]+)\)/.exec(message || '');
  return match ? match[1] : null;
}

/**
 * Fetch all ad sets for a given Meta campaign.
 *
 * targeting{...} sub-fields are requested speculatively (Attribution &
 * Customer Journey Intelligence's audience-type classification, Step 9).
 * Meta API versions/accounts can reject an individual sub-field with
 * "(#100) Tried accessing nonexisting field (X)" -- this used to fail the
 * ENTIRE ad sets fetch (and therefore the entire account's sync) over one
 * unsupported sub-field. Since the failure names the exact offending field,
 * it's stripped and the request retried rather than aborting the sync.
 *
 * @param {string} metaCampaignId
 * @param {string} accessToken
 * @param {object} [options]
 * @param {boolean} [options.activeOnly] - server-side filter to
 *   effective_status=ACTIVE ad sets only (see fetchCampaigns()'s activeOnly).
 * @returns {Array} Raw ad set objects from Meta
 */
async function fetchAdSets(metaCampaignId, accessToken, options = {}) {
  const { activeOnly = false } = options;
  const filterParam = activeOnly ? { filtering: buildEffectiveStatusFilter(['ACTIVE']) } : {};
  const baseFields = 'id,name,status,effective_status,daily_budget,lifetime_budget,created_time,updated_time,optimization_goal';
  // locales -- Language Analytics' configuration view (Phase 17).
  // custom_audiences / excluded_custom_audiences / lookalike_spec /
  //   flexible_spec / geo_locations / targeting_automation --
  //   Attribution & Customer Journey Intelligence's audience-type
  //   classification (Step 9). custom_audiences' referenced audience
  //   IDs are resolved to their real subtype (CUSTOM/WEBSITE/
  //   ENGAGEMENT/APP/LOOKALIKE) via a separate, ACCOUNT-level (not
  //   per-ad-set) fetchCustomAudiences() call, cached and joined by id
  //   -- that subtype is NOT a property of the ad set's own targeting.
  // targeting_automation.advantage_audience -- real Meta field marking
  //   Advantage+ Audience; without it, an Advantage+ ad set would be
  //   indistinguishable from a broad one.
  let targetingFields = ['locales', 'custom_audiences', 'excluded_custom_audiences', 'lookalike_spec', 'flexible_spec', 'geo_locations', 'targeting_automation'];

  // Sub-fields requested as PLAIN names within targeting{}, never further
  // nested -- confirmed via a real production bug (fetchAdCreativeDetail()'s
  // asset_feed_spec{id} request) that guessing a *second* level of `{}`
  // sub-field expansion on a JSON-blob-shaped field reliably 400s.
  for (let attempt = 0; attempt <= targetingFields.length; attempt++) {
    const fields = targetingFields.length
      ? `${baseFields},targeting{${targetingFields.join(',')}}`
      : baseFields;

    try {
      return await metaGetAll(`${metaCampaignId}/adsets`, { fields, limit: 100, ...filterParam }, accessToken);
    } catch (err) {
      const badField = extractNonexistingField(err.message);
      if (badField && targetingFields.includes(badField)) {
        console.warn(`[Meta API] targeting.${badField} unsupported for this account/API version -- retrying ad sets fetch without it`);
        targetingFields = targetingFields.filter(f => f !== badField);
        continue;
      }
      throw err;
    }
  }

  // All targeting sub-fields were rejected -- fall back to base fields only.
  return metaGetAll(`${metaCampaignId}/adsets`, { fields: baseFields, limit: 100, ...filterParam }, accessToken);
}

/**
 * Fetch all ads for a given Meta ad set.
 *
 * @param {string} metaAdSetId
 * @param {string} accessToken
 * @param {object} [options]
 * @param {boolean} [options.activeOnly] - server-side filter to
 *   effective_status=ACTIVE ads only (see fetchCampaigns()'s activeOnly).
 * @returns {Array} Raw ad objects from Meta
 */
async function fetchAds(metaAdSetId, accessToken, options = {}) {
  const { activeOnly = false } = options;
  const params = {
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
  };
  if (activeOnly) params.filtering = buildEffectiveStatusFilter(['ACTIVE']);

  const ads = await metaGetAll(`${metaAdSetId}/ads`, params, accessToken);

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
      // Library, Step 11/12) without a second Meta call.
      //
      // body/title/link_url/call_to_action_type/object_story_id/
      // effective_object_story_id -- Phase 40 fix: these are Meta's own
      // FLAT, top-level AdCreative fields carrying primary text/headline/
      // destination/CTA. Confirmed via live Graph API verification (real
      // production ad accounts) that the majority of real-world creatives
      // are boosted Page posts (object_type STATUS/PHOTO/SHARE) built from
      // an existing Page post via object_story_id, NOT from an explicit
      // object_story_spec -- for those, object_story_spec.link_data/
      // video_data are absent entirely and Meta only ever returns the
      // content on these flat fields. The previous version of this request
      // never asked for them, so headline/primary_text/CTA/destination came
      // back null for effectively every real creative, regardless of what
      // Meta actually had. object_story_spec is still requested below as a
      // secondary source for the (rarer) creatives that do carry an
      // explicit spec, and to detect carousel (child_attachments).
      // asset_feed_spec is requested only to detect its PRESENCE -- Dynamic
      // Creative / Advantage+ creatives use asset_feed_spec instead of a
      // single object_story_spec. Requested as a plain field, not
      // `asset_feed_spec{id}` -- confirmed via live Meta API verification
      // that asset_feed_spec does not support `{id}` sub-field expansion
      // (Meta returns "(#100) Tried accessing nonexisting field (id)"); the
      // plain field already returns its full object when present, or is
      // simply absent from the response otherwise -- exactly the
      // presence/absence signal this needs, no extra request shape required.
      fields: 'creative{id,name,status,object_type,video_id,image_url,image_hash,thumbnail_url,' +
              'body,title,link_url,call_to_action_type,object_story_id,effective_object_story_id,' +
              'object_story_spec{link_data{link,message,name,description,picture,call_to_action{type,value},child_attachments{link,name,description,image_hash}},' +
              'video_data{message,title,link_description,image_url,call_to_action{type,value}}},' +
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
  isAuthError,
  isNetworkError,
  getPacingStatus,
  resetPacing,
};
