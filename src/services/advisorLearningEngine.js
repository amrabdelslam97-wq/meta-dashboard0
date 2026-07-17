/**
 * AI Marketing Advisor — Account & Campaign Learning (Phase 42, Steps 12-13)
 *
 * Aggregated pattern-learning over already-persisted creative_analytics rows
 * (score_overall + ai_analysis_json from Phase 21's Creative Score/Phase 41's
 * text analysis). Never stores anything new (no schema change, no new
 * table) -- computed fresh on every call from real, already-scored
 * creatives, comparing a top-scoring group ("winners") against a
 * bottom-scoring group ("losers") for the SAME account/campaign so any
 * reported pattern is a real, current cross-creative signal, not a
 * fabricated or hallucinated one. Below the minimum sample size, every
 * function here reports insufficient_data honestly rather than guessing.
 */

const db = require('../db/database');

const ACCOUNT_MIN_SAMPLE = 6;
const CAMPAIGN_MIN_SAMPLE = 4;
const PATTERN_GAP_THRESHOLD_PCT = 25; // winners_pct - losers_pct must clear this to be reported as a real pattern

function round(n, dp = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function parseAnalysis(row) {
  try {
    return row.ai_analysis_json ? JSON.parse(row.ai_analysis_json) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Feature extraction — every flag traces to a real field already computed
// by creativeTextAnalysis.js/analyzeCreative() (Phase 41), nothing invented.
// ─────────────────────────────────────────────

const FEATURE_LABELS = {
  has_emoji: 'Emoji in the hook',
  has_question_hook: 'Question-based hook',
  has_curiosity_hook: 'Curiosity-trigger hook',
  has_urgency: 'Urgency language',
  has_social_proof: 'Social proof / customer reviews',
  has_authority: 'Authority / expert positioning',
  has_guarantee: 'Guarantee language',
  short_copy: 'Short copy (<=20 words)',
  long_copy: 'Long copy (>60 words)',
  strong_cta: 'Strong, specific CTA',
  messaging_cta: 'WhatsApp/Messenger click-to-chat CTA',
  clear_offer: 'Clear, concrete offer',
};

const MESSAGING_CTA_TYPES = new Set(['WHATSAPP_MESSAGE', 'MESSAGE_PAGE', 'SEND_MESSAGE']);

function extractFeatures(analysis, ctaType) {
  const hookKeys = new Set((analysis?.hook?.detected || []).map(d => d.key));
  return {
    has_emoji: hookKeys.has('emoji'),
    has_question_hook: hookKeys.has('question'),
    has_curiosity_hook: hookKeys.has('curiosity'),
    has_urgency: !!analysis?.psychology?.dimensions?.urgency,
    has_social_proof: !!(analysis?.trust?.social_proof || analysis?.psychology?.dimensions?.social_proof),
    has_authority: !!analysis?.psychology?.dimensions?.authority,
    has_guarantee: !!analysis?.psychology?.dimensions?.guarantee,
    short_copy: analysis?.copy?.length_category === 'short',
    long_copy: analysis?.copy?.length_category === 'long',
    strong_cta: analysis?.cta?.label === 'strong',
    messaging_cta: MESSAGING_CTA_TYPES.has(String(ctaType || '').toUpperCase()),
    clear_offer: analysis?.offer?.label === 'clear',
  };
}

/** Splits score-sorted rows into top/bottom quartile groups without overlap. */
function splitWinnersLosers(rowsDesc) {
  const quartileSize = Math.max(2, Math.min(Math.floor(rowsDesc.length / 4), Math.floor(rowsDesc.length / 2)));
  return { winners: rowsDesc.slice(0, quartileSize), losers: rowsDesc.slice(-quartileSize) };
}

function tallyFeaturePercentages(group) {
  const counts = Object.fromEntries(Object.keys(FEATURE_LABELS).map(k => [k, 0]));
  for (const row of group) {
    const features = extractFeatures(row._analysis, row.cta_type);
    for (const key of Object.keys(counts)) if (features[key]) counts[key]++;
  }
  const pct = {};
  for (const key of Object.keys(counts)) pct[key] = group.length ? round((counts[key] / group.length) * 100) : 0;
  return pct;
}

function buildPatterns(winnerPct, loserPct) {
  const winning = [];
  const failing = [];
  for (const key of Object.keys(FEATURE_LABELS)) {
    const gap = winnerPct[key] - loserPct[key];
    if (gap >= PATTERN_GAP_THRESHOLD_PCT) {
      winning.push({ pattern: FEATURE_LABELS[key], winners_pct: winnerPct[key], losers_pct: loserPct[key], gap: round(gap) });
    } else if (-gap >= PATTERN_GAP_THRESHOLD_PCT) {
      failing.push({ pattern: FEATURE_LABELS[key], winners_pct: winnerPct[key], losers_pct: loserPct[key], gap: round(-gap) });
    }
  }
  winning.sort((a, b) => b.gap - a.gap);
  failing.sort((a, b) => b.gap - a.gap);
  return { winning_patterns: winning, failing_patterns: failing };
}

// ─────────────────────────────────────────────
// PHASE 12 — Account Learning
// ─────────────────────────────────────────────

function getAccountCreativeLearning(accountId) {
  const rows = db.all(
    `SELECT ca.* FROM creative_analytics ca
     INNER JOIN (
       SELECT meta_ad_id, MAX(date_until) as max_until FROM creative_analytics
       WHERE ad_account_id = ? GROUP BY meta_ad_id
     ) latest ON latest.meta_ad_id = ca.meta_ad_id AND latest.max_until = ca.date_until
     WHERE ca.ad_account_id = ? AND ca.spend >= 5 AND ca.score_overall IS NOT NULL`,
    [accountId, accountId]
  );

  if (rows.length < ACCOUNT_MIN_SAMPLE) {
    return {
      status: 'insufficient_data',
      sample_size: rows.length,
      reason: `Need at least ${ACCOUNT_MIN_SAMPLE} scored creatives (>= $5 spend) to detect account-level patterns -- currently have ${rows.length}.`,
    };
  }

  for (const r of rows) r._analysis = parseAnalysis(r);
  rows.sort((a, b) => b.score_overall - a.score_overall);
  const { winners, losers } = splitWinnersLosers(rows);
  const winnerPct = tallyFeaturePercentages(winners);
  const loserPct = tallyFeaturePercentages(losers);
  const { winning_patterns, failing_patterns } = buildPatterns(winnerPct, loserPct);

  return {
    status: 'ok',
    sample_size: { total: rows.length, winners: winners.length, losers: losers.length },
    winning_patterns,
    failing_patterns,
    methodology: `Winners = top score_overall quartile, losers = bottom quartile, minimum $5 spend, most recent snapshot per ad. A pattern is only reported when the winner/loser prevalence gap is >= ${PATTERN_GAP_THRESHOLD_PCT} percentage points.`,
  };
}

// ─────────────────────────────────────────────
// PHASE 13 — Campaign Learning
// ─────────────────────────────────────────────

const MESSAGE_CATEGORY_RULES = [
  ['has_social_proof', 'Customer reviews / social proof'],
  ['has_authority', 'Authority / expert positioning'],
  ['has_guarantee', 'Guarantee / risk reversal'],
  ['has_urgency', 'Urgency / scarcity'],
  ['clear_offer', 'Concrete offer / pricing'],
];

function classifyDominantMessage(analysis, ctaType) {
  const features = extractFeatures(analysis, ctaType);
  for (const [key, label] of MESSAGE_CATEGORY_RULES) {
    if (features[key]) return label;
  }
  if (features.short_copy && features.strong_cta) return 'Direct, benefit-led messaging';
  return 'General branding (no distinct persuasion pattern detected)';
}

function resolveCampaignMetaId(idOrMetaId) {
  const row = db.get('SELECT meta_campaign_id FROM campaigns WHERE id = ? OR meta_campaign_id = ?', [idOrMetaId, idOrMetaId]);
  return row?.meta_campaign_id || idOrMetaId;
}

function getCampaignCreativeLearning(campaignId) {
  const metaCampaignId = resolveCampaignMetaId(campaignId);

  const rows = db.all(
    `SELECT ca.*, a.name as ad_name FROM creative_analytics ca
     LEFT JOIN ads a ON a.meta_ad_id = ca.meta_ad_id
     INNER JOIN (
       SELECT meta_ad_id, MAX(date_until) as max_until FROM creative_analytics
       WHERE meta_campaign_id = ? GROUP BY meta_ad_id
     ) latest ON latest.meta_ad_id = ca.meta_ad_id AND latest.max_until = ca.date_until
     WHERE ca.meta_campaign_id = ? AND ca.spend >= 5 AND ca.score_overall IS NOT NULL`,
    [metaCampaignId, metaCampaignId]
  );

  if (rows.length === 0) {
    return { status: 'insufficient_data', sample_size: 0, reason: 'No scored creatives (>= $5 spend) found for this campaign yet.' };
  }

  for (const r of rows) r._analysis = parseAnalysis(r);
  rows.sort((a, b) => b.score_overall - a.score_overall);

  const top = rows[0];
  const bottom = rows[rows.length - 1];
  const lessons = {
    most_successful_message: top !== bottom ? {
      meta_ad_id: top.meta_ad_id, ad_name: top.ad_name || top.meta_ad_id, score_overall: top.score_overall,
      message_category: classifyDominantMessage(top._analysis, top.cta_type),
    } : null,
    weakest_message: top !== bottom ? {
      meta_ad_id: bottom.meta_ad_id, ad_name: bottom.ad_name || bottom.meta_ad_id, score_overall: bottom.score_overall,
      message_category: classifyDominantMessage(bottom._analysis, bottom.cta_type),
    } : null,
  };

  if (rows.length < CAMPAIGN_MIN_SAMPLE) {
    return {
      status: 'partial',
      sample_size: rows.length,
      reason: `Only ${rows.length} scored creative(s) -- showing the single best/weakest message but not enough volume for a reliable winning/failing-pattern breakdown (need ${CAMPAIGN_MIN_SAMPLE}+).`,
      ...lessons,
      winning_patterns: [],
      failing_patterns: [],
    };
  }

  const { winners, losers } = splitWinnersLosers(rows);
  const winnerPct = tallyFeaturePercentages(winners);
  const loserPct = tallyFeaturePercentages(losers);
  const { winning_patterns, failing_patterns } = buildPatterns(winnerPct, loserPct);

  return {
    status: 'ok',
    sample_size: { total: rows.length, winners: winners.length, losers: losers.length },
    ...lessons,
    winning_patterns,
    failing_patterns,
  };
}

module.exports = {
  getAccountCreativeLearning,
  getCampaignCreativeLearning,
};
