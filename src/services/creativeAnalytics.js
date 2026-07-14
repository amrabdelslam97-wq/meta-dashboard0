/**
 * Creative Analytics — Executive Marketing Analytics Layer (Phase 17)
 *
 * Per-ad creative detail (headline/primary text/description/CTA/video) +
 * video engagement performance (hook rate, hold rate, drop-off, watch-time
 * percentiles). Reuses existing architecture end to end:
 *   - Performance data: metricsFetcher.fetchAdMetrics() (already fetches
 *     every ad's spend/results/video_pXX_watched/thruplays/avg_watch_time in
 *     ONE call per campaign -- no new Insights call shape introduced here).
 *   - Creative content: metaApiClient.fetchAdCreativeDetail() (Phase 17's one
 *     genuinely new Meta call, since headline/body/CTA aren't Insights fields).
 *   - Storage: creative_analytics (schema.phase19.js).
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { fetchAdMetrics } = require('./metricsFetcher');
const { fetchAdCreativeDetail, fetchVideoDetail, isRateLimitError } = require('./metaApiClient');
const { decryptToken } = require('./tokenCrypto');
const { defaultRange } = require('./dateRangeHelper');
const { buildInsight } = require('./analyticsInsight');
const { computeCreativeScore, detectFatigue } = require('./creativeIntelligenceEngine');

// Same fairness/rate-limit-safety reasoning as analyticsEngine.js's
// MAX_CAMPAIGNS_PER_CYCLE -- fetchAdCreativeDetail() is one call per ad, so
// an account with hundreds of ads needs a per-cycle cap too.
const MAX_ADS_PER_CYCLE = 20;

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pct(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  return round((numerator / denominator) * 100, 2);
}

/**
 * Extracts headline/body/description/CTA/destination/media-hash.
 *
 * Meta's flat, top-level AdCreative fields (body/title/link_url/
 * call_to_action_type) are the PRIMARY source -- confirmed via live Graph
 * API verification that most real creatives are boosted Page posts
 * (object_type STATUS/PHOTO/SHARE, built from object_story_id) which never
 * populate object_story_spec at all; Meta only ever returns their content on
 * these flat fields. object_story_spec.link_data/video_data is checked as a
 * fallback for creatives that do carry an explicit spec. Never fabricates a
 * value Meta didn't actually return.
 */
function extractCreativeContent(creative) {
  const spec = creative?.object_story_spec || {};
  const linkData = spec.link_data;
  const videoData = spec.video_data;

  let creativeType = 'unknown';
  if (creative?.video_id || videoData) creativeType = 'video';
  else if (linkData?.child_attachments?.length) creativeType = 'carousel';
  else if (creative?.image_url || linkData?.picture) creativeType = 'image';
  else if (creative?.object_type) creativeType = String(creative.object_type).toLowerCase();

  const source = videoData || linkData || {};
  const cta = creative?.call_to_action_type || source.call_to_action?.type || null;
  // The destination URL lives on the flat link_url field, under the CTA's
  // `value.link` for a video ad, or directly on link_data.link for a
  // link/image ad -- none of these are the same shape.
  const destinationUrl = creative?.link_url || linkData?.link || source.call_to_action?.value?.link || null;

  return {
    creative_type: creativeType,
    headline: creative?.title || linkData?.name || videoData?.title || null,
    primary_text: creative?.body || linkData?.message || videoData?.message || null,
    description: linkData?.description || videoData?.link_description || null,
    cta_type: cta,
    image_url: creative?.image_url || linkData?.picture || null,
    video_id: creative?.video_id || null,
    thumbnail_url: creative?.thumbnail_url || null,
    destination_url: destinationUrl,
    media_hash: creative?.image_hash || null,
    // asset_feed_spec is Dynamic Creative / Advantage+'s multi-asset
    // container, requested as {id} only (see metaApiClient.js) -- its mere
    // presence (regardless of value) is what distinguishes a Dynamic
    // Creative ad from a standard single-object_story_spec one.
    is_dynamic_creative: !!creative?.asset_feed_spec,
  };
}

/** Real, non-fabricated derived metrics computed from adMetricsRow's already-fetched fields -- no new Meta calls. */
function deriveExtendedMetrics(m, videoPlays) {
  const conversionRate = m.clicks > 0 && m.results != null ? round((m.results / m.clicks) * 100, 2) : null;
  const engagementSum = (m.post_engagements ?? m.page_engagements ?? 0) || ((m.page_likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0));
  const engagementRate = m.impressions > 0 && engagementSum > 0 ? round((engagementSum / m.impressions) * 100, 2) : null;
  const thumbStopRate = m.impressions > 0 && videoPlays > 0 ? round((videoPlays / m.impressions) * 100, 2) : null;

  return {
    cpc: m.cpc ?? null,
    frequency: m.frequency ?? null,
    reach: m.reach ?? null,
    impressions: m.impressions ?? null,
    roas: m.roas ?? null,
    conversion_rate: conversionRate,
    engagement_rate: engagementRate,
    comments: m.comments ?? null,
    shares: m.shares ?? null,
    likes: m.page_likes ?? null,
    saves: m.saves ?? null,
    link_clicks: m.link_clicks ?? null,
    outbound_ctr: m.outbound_ctr ?? null,
    landing_page_views: m.landing_page_views ?? null,
    unique_ctr: m.unique_ctr ?? null,
    video_3sec_plays: videoPlays || null, // Meta's "3-Second Video Plays" Ads Manager column maps to video_play_actions, already fetched
    thumb_stop_rate: thumbStopRate,
  };
}

/**
 * Persist one ad's creative detail + this-period performance snapshot,
 * including the computed Creative Score (Step 4), Fatigue verdict (Step 5),
 * and AI text analysis (Step 3) -- all derived from data already fetched
 * this same sync pass plus this ad's own prior snapshots (no new Meta calls
 * for scoring/fatigue/analysis).
 *
 * `adMetricsRow` is one row from metricsFetcher.fetchAdMetrics()'s output
 * (already-normalized spend/results/video metrics for this ad).
 * `videoLengthSec` is only non-null when this ad's creative has a video_id
 * and syncAccountCreativeAnalytics() fetched it this pass.
 * `historyRows` are this ad's PRIOR creative_analytics rows (any earlier
 * date range), used only for fatigue trend detection.
 */
function persistCreativeSnapshot(tx, adAccountId, ad, creativeContent, adMetricsRow, dateRange, videoLengthSec, historyRows) {
  const m = adMetricsRow || {};
  const videoPlays = m.video_plays || 0;
  const p25 = pct(m.video_p25_watched, videoPlays);
  const p50 = pct(m.video_p50_watched, videoPlays);
  const p75 = pct(m.video_p75_watched, videoPlays);
  const p95 = pct(m.video_p95_watched, videoPlays);
  const p100 = pct(m.video_p100_watched, videoPlays);
  const holdRate = pct(m.thruplays, videoPlays); // ThruPlay rate: "held" through a meaningful watch
  const dropOffPct = p25 !== null ? round(100 - p25, 2) : null; // early (pre-25%) drop-off
  const extended = deriveExtendedMetrics(m, videoPlays);

  // ── Step 3/4/5 — AI text analysis, Creative Score, Fatigue Detection ──
  const currentForScoring = {
    headline: creativeContent.headline, primary_text: creativeContent.primary_text,
    description: creativeContent.description, cta_type: creativeContent.cta_type,
    media_type: creativeContent.creative_type, aspect_ratio: null, video_length_sec: videoLengthSec,
    spend: m.spend ?? 0, results: m.results ?? null, ctr: m.ctr ?? 0, cost_per_result: m.cpr ?? m.cpa ?? null,
    video_p25_pct: p25, video_p100_pct: p100, hold_rate: holdRate, thumb_stop_rate: extended.thumb_stop_rate,
  };
  const fatigueHistory = [...(historyRows || []), {
    spend: m.spend ?? 0, frequency: extended.frequency, ctr: m.ctr ?? 0, cpc: extended.cpc, cpm: m.cpm ?? 0,
    conversion_rate: extended.conversion_rate, reach: extended.reach, results: m.results ?? 0,
    cost_per_result: m.cpr ?? m.cpa ?? null, date_since: dateRange.since, date_until: dateRange.until,
  }];
  const fatigue = detectFatigue(fatigueHistory);
  const scored = computeCreativeScore(currentForScoring, fatigue.status === 'insufficient_data' ? null : fatigue);
  const aiAnalysisJson = JSON.stringify(scored.text_analysis);

  tx.run(
    `INSERT INTO creative_analytics (
       id, ad_account_id, meta_ad_id, meta_adset_id, meta_campaign_id, creative_id, creative_name,
       creative_type, image_url, video_id, thumbnail_url, headline, primary_text, description, cta_type,
       video_length_sec, video_ratio, image_ratio, date_since, date_until, spend, results, ctr, cpm, cpa,
       video_p25_pct, video_p50_pct, video_p75_pct, video_p95_pct, video_p100_pct, thruplay_count,
       avg_watch_time_sec, hold_rate, drop_off_pct, destination_type, calculated_at,
       cpc, frequency, reach, impressions, roas, conversion_rate, engagement_rate, comments, shares,
       likes, saves, link_clicks, outbound_ctr, landing_page_views, unique_ctr, video_3sec_plays, thumb_stop_rate,
       destination_url, media_hash, aspect_ratio, media_type, is_dynamic_creative, ai_analysis_json,
       score_hook, score_headline, score_copy, score_visual, score_cta, score_offer, score_trust,
       score_psychology, score_conversion_potential, score_scroll_stop, score_retention, score_brand,
       score_fatigue, score_overall, fatigue_status, fatigue_recommendation
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               ?,?,?,?,?,?,
               ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(meta_ad_id, date_since, date_until) DO UPDATE SET
       creative_id = excluded.creative_id, creative_name = excluded.creative_name,
       creative_type = excluded.creative_type, image_url = excluded.image_url, video_id = excluded.video_id,
       thumbnail_url = excluded.thumbnail_url, headline = excluded.headline, primary_text = excluded.primary_text,
       description = excluded.description, cta_type = excluded.cta_type, video_length_sec = excluded.video_length_sec,
       spend = excluded.spend, results = excluded.results, ctr = excluded.ctr, cpm = excluded.cpm, cpa = excluded.cpa,
       video_p25_pct = excluded.video_p25_pct, video_p50_pct = excluded.video_p50_pct,
       video_p75_pct = excluded.video_p75_pct, video_p95_pct = excluded.video_p95_pct,
       video_p100_pct = excluded.video_p100_pct, thruplay_count = excluded.thruplay_count,
       avg_watch_time_sec = excluded.avg_watch_time_sec, hold_rate = excluded.hold_rate,
       drop_off_pct = excluded.drop_off_pct, destination_type = excluded.destination_type,
       cpc = excluded.cpc, frequency = excluded.frequency, reach = excluded.reach, impressions = excluded.impressions,
       roas = excluded.roas, conversion_rate = excluded.conversion_rate, engagement_rate = excluded.engagement_rate,
       comments = excluded.comments, shares = excluded.shares, likes = excluded.likes, saves = excluded.saves,
       link_clicks = excluded.link_clicks, outbound_ctr = excluded.outbound_ctr,
       landing_page_views = excluded.landing_page_views, unique_ctr = excluded.unique_ctr,
       video_3sec_plays = excluded.video_3sec_plays, thumb_stop_rate = excluded.thumb_stop_rate,
       destination_url = excluded.destination_url, media_hash = excluded.media_hash,
       aspect_ratio = excluded.aspect_ratio, media_type = excluded.media_type,
       is_dynamic_creative = excluded.is_dynamic_creative, ai_analysis_json = excluded.ai_analysis_json,
       score_hook = excluded.score_hook, score_headline = excluded.score_headline, score_copy = excluded.score_copy,
       score_visual = excluded.score_visual, score_cta = excluded.score_cta, score_offer = excluded.score_offer,
       score_trust = excluded.score_trust, score_psychology = excluded.score_psychology,
       score_conversion_potential = excluded.score_conversion_potential, score_scroll_stop = excluded.score_scroll_stop,
       score_retention = excluded.score_retention, score_brand = excluded.score_brand,
       score_fatigue = excluded.score_fatigue, score_overall = excluded.score_overall,
       fatigue_status = excluded.fatigue_status, fatigue_recommendation = excluded.fatigue_recommendation,
       calculated_at = excluded.calculated_at`,
    [
      uuidv4(), adAccountId, ad.meta_ad_id, ad.meta_adset_id, ad.meta_campaign_id,
      ad.creative_id || null,
      null, // creative_name intentionally left null -- Meta's creative.name is an internal label, not shown here to avoid confusing it with headline
      creativeContent.creative_type, creativeContent.image_url, creativeContent.video_id, creativeContent.thumbnail_url,
      creativeContent.headline, creativeContent.primary_text, creativeContent.description, creativeContent.cta_type,
      videoLengthSec, null, null, // video_ratio/image_ratio -- not derivable without image/video dimension data this system doesn't fetch; left honestly null
      dateRange.since, dateRange.until,
      m.spend ?? 0, m.results ?? null, m.ctr ?? 0, m.cpm ?? 0, m.cpa ?? null,
      p25, p50, p75, p95, p100, m.thruplays ?? null, m.video_avg_watch_time ?? null, holdRate, dropOffPct,
      ad.destination_type || null,
      new Date().toISOString(),
      extended.cpc, extended.frequency, extended.reach, extended.impressions, extended.roas,
      extended.conversion_rate, extended.engagement_rate, extended.comments, extended.shares,
      extended.likes, extended.saves, extended.link_clicks, extended.outbound_ctr,
      extended.landing_page_views, extended.unique_ctr, extended.video_3sec_plays, extended.thumb_stop_rate,
      creativeContent.destination_url, creativeContent.media_hash, null, creativeContent.creative_type,
      creativeContent.is_dynamic_creative ? 1 : 0, aiAnalysisJson,
      scored.score_hook, scored.score_headline, scored.score_copy, scored.score_visual, scored.score_cta,
      scored.score_offer, scored.score_trust, scored.score_psychology, scored.score_conversion_potential,
      scored.score_scroll_stop, scored.score_retention, scored.score_brand, scored.score_fatigue, scored.score_overall,
      fatigue.status, fatigue.recommendation,
    ]
  );
}

/**
 * Sync creative analytics for one account: refreshes creative content detail
 * for up to MAX_ADS_PER_CYCLE ads (oldest-analyzed-first) and persists a
 * performance snapshot for every ad metricsFetcher.fetchAdMetrics() returns
 * data for in that same campaign call (no extra Meta calls for those).
 */
async function syncAccountCreativeAnalytics(account, dateRange = defaultRange()) {
  const accessToken = decryptToken(account.access_token_encrypted);

  const adsNeedingDetail = db.all(
    `SELECT a.id, a.meta_ad_id, s.meta_adset_id, a.creative_id, a.destination_type, c.meta_campaign_id
     FROM ads a
     JOIN ad_sets s ON s.id = a.ad_set_id
     JOIN campaigns c ON c.id = a.campaign_id
     LEFT JOIN creative_analytics ca ON ca.meta_ad_id = a.meta_ad_id AND ca.date_since = ? AND ca.date_until = ?
     WHERE a.ad_account_id = ? AND a.status = 'active' AND ca.id IS NULL
     ORDER BY a.updated_at ASC
     LIMIT ?`,
    [dateRange.since, dateRange.until, account.id, MAX_ADS_PER_CYCLE]
  );

  const summary = { adsProcessed: 0, apiCalls: 0, errors: [] };
  if (adsNeedingDetail.length === 0) return summary;

  // One fetchAdMetrics() call per distinct campaign covers every ad in it.
  const campaignIds = [...new Set(adsNeedingDetail.map(a => a.meta_campaign_id))];
  const metricsByAdId = new Map();
  for (const metaCampaignId of campaignIds) {
    try {
      summary.apiCalls++;
      const rows = await fetchAdMetrics(metaCampaignId, accessToken, dateRange.since, dateRange.until, account.attribution_window_days);
      for (const row of rows) metricsByAdId.set(row.meta_ad_id, row);
    } catch (err) {
      summary.errors.push({ campaign: metaCampaignId, message: err.message });
      if (isRateLimitError(err)) throw err;
    }
  }

  for (const ad of adsNeedingDetail) {
    try {
      summary.apiCalls++;
      const creative = await fetchAdCreativeDetail(ad.meta_ad_id, accessToken);
      const content = extractCreativeContent(creative);
      const metricsRow = metricsByAdId.get(ad.meta_ad_id) || null;

      // Video length (Step 1) -- one extra call, only for video creatives,
      // only once per ad ever (checked via any prior snapshot already
      // having it), not once per sync cycle.
      let videoLengthSec = null;
      if (content.video_id) {
        const alreadyKnown = db.get(
          `SELECT video_length_sec FROM creative_analytics WHERE meta_ad_id = ? AND video_length_sec IS NOT NULL LIMIT 1`,
          [ad.meta_ad_id]
        );
        if (alreadyKnown) {
          videoLengthSec = alreadyKnown.video_length_sec;
        } else {
          try {
            summary.apiCalls++;
            videoLengthSec = await fetchVideoDetail(content.video_id, accessToken);
          } catch (videoErr) {
            summary.errors.push({ ad: ad.meta_ad_id, message: `video length fetch: ${videoErr.message}` });
          }
        }
      }

      // Prior snapshots for this ad (any earlier date range) -- fuels
      // Fatigue Detection's trend comparison (Step 5), not a new Meta call.
      const historyRows = db.all(
        `SELECT spend, frequency, ctr, cpc, cpm, conversion_rate, reach, results, cpa as cost_per_result, date_since, date_until
         FROM creative_analytics WHERE meta_ad_id = ? AND date_until < ? ORDER BY date_since ASC`,
        [ad.meta_ad_id, dateRange.since]
      );

      db.transaction(tx => persistCreativeSnapshot(tx, account.id, ad, content, metricsRow, dateRange, videoLengthSec, historyRows));
      summary.adsProcessed++;
    } catch (err) {
      summary.errors.push({ ad: ad.meta_ad_id, message: err.message });
      if (isRateLimitError(err)) throw err;
    }
  }

  return summary;
}

/**
 * Read side (no Meta calls) -- creative performance for a campaign, ranked,
 * with the same AI-prep insight shape every other analytics domain uses.
 */
function getCreativeAnalytics(metaCampaignId, dateRange = defaultRange()) {
  const rows = db.all(
    `SELECT * FROM creative_analytics WHERE meta_campaign_id = ? AND date_since = ? AND date_until = ? ORDER BY spend DESC`,
    [metaCampaignId, dateRange.since, dateRange.until]
  );
  return {
    date_range: dateRange,
    creatives: rows,
    insight: buildInsight(rows, { costKey: 'cpa', labelKey: 'headline' }),
  };
}

module.exports = {
  MAX_ADS_PER_CYCLE,
  extractCreativeContent,
  syncAccountCreativeAnalytics,
  getCreativeAnalytics,
};
