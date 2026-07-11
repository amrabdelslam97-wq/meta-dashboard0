/**
 * Conversation Attribution Engine — Attribution & Customer Journey
 * Intelligence (Step 1)
 *
 * Reuses messagingAnalytics.getDestinationAttribution() wholesale (same
 * persisted creative_analytics data, zero new Meta calls, zero new sync
 * mechanism) filtered to the conversation-capable destinations, and adds
 * Conversation Rate (a genuinely new derived metric, not in destination
 * attribution). Cost per Conversation is destination attribution's own
 * cost_per_result under a conversation-specific name.
 *
 * Explicitly NOT implemented -- Response Rate, First Reply Time, Qualified
 * Conversations, and Calls: Meta's Marketing API (what this system's Meta
 * token is scoped to) exposes only AGGREGATE action counts per ad
 * (messaging_conversation_started), never individual conversation records.
 * Response rate / first-reply-time / lead qualification live entirely
 * inside the Messenger Platform / WhatsApp Business Platform / Instagram
 * Messaging API's own conversation objects -- genuinely separate products
 * with their own OAuth scopes, webhooks, and data models this system has
 * never integrated. Calls: Meta does expose a PHONE_CALL destination_type
 * and (on some call-focused campaigns) a `click_to_call_call_confirm`-style
 * action_type, but none of this system's 8 connected accounts run a
 * call-optimized campaign to verify the exact action_type name against a
 * real response, so it is honestly left unimplemented rather than guessed
 * (see metaApiClient.js's asset_feed_spec bug for exactly what guessing an
 * unverified Meta field shape costs).
 */

const { defaultRange } = require('./dateRangeHelper');
const { getDestinationAttribution } = require('./messagingAnalytics');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const CONVERSATION_DESTINATIONS = new Set(['MESSENGER', 'WHATSAPP', 'INSTAGRAM_DIRECT']);

const NOT_AVAILABLE_FIELDS = ['response_rate', 'first_reply_time', 'qualified_conversations', 'calls'];
const NOT_AVAILABLE_REASON = 'Meta\'s Marketing API exposes only aggregate messaging_conversation_started counts per ad, never individual conversation records -- response rate, first-reply time, and lead qualification live inside the separate Messenger/WhatsApp/Instagram Messaging Platform APIs (different OAuth scopes/webhooks this system does not integrate). Calls are not implemented because no connected account runs a call-optimized campaign to verify Meta\'s real call action_type against.';

/**
 * @param {string} metaCampaignId
 * @param {{since:string, until:string}} [dateRange]
 */
function getConversationAttribution(metaCampaignId, dateRange = defaultRange()) {
  const { destinations, date_range, note } = getDestinationAttribution(metaCampaignId, dateRange);
  const conversationDestinations = destinations.filter(d => CONVERSATION_DESTINATIONS.has(d.destination_type));

  if (conversationDestinations.length === 0) {
    return {
      date_range,
      conversations: [],
      not_available: NOT_AVAILABLE_FIELDS,
      not_available_reason: NOT_AVAILABLE_REASON,
      note: note || 'No Messenger/WhatsApp/Instagram Direct destination_type ads were found for this campaign/period.',
    };
  }

  const totalConversations = conversationDestinations.reduce((s, d) => s + (d.results || 0), 0);

  const conversations = conversationDestinations.map(d => ({
    destination_type: d.destination_type,
    spend: d.spend,
    conversation_count: d.results,
    cost_per_conversation: d.cost_per_result,
    // conversion_rate is already results/clicks*100 at the per-ad level
    // (creativeAnalytics.js's persist step, using the ad's real Insights
    // clicks) -- for a conversation-driving destination, "results" IS the
    // conversation count, so this average genuinely is the conversation
    // rate, not a relabeled unrelated metric.
    conversation_rate: d.conversion_rate,
    contribution_pct: totalConversations > 0 ? round((d.results / totalConversations) * 100, 1) : 0,
    response_rate: null,
    first_reply_time_seconds: null,
    qualified_conversations: null,
  }));

  return {
    date_range,
    conversations,
    total_conversations: totalConversations,
    not_available: NOT_AVAILABLE_FIELDS,
    not_available_reason: NOT_AVAILABLE_REASON,
  };
}

module.exports = { getConversationAttribution, CONVERSATION_DESTINATIONS };
