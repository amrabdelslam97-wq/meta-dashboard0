/**
 * Meta Lifecycle
 *
 * Single source of truth for "is this entity actually delivering right
 * now, according to Meta" and what the AI/Dashboard should do about it
 * when it isn't. Root cause this exists to fix: `status` (ACTIVE/PAUSED/
 * ARCHIVED/DELETED) is only what the advertiser/API directly set at THIS
 * level -- it is not the same as real delivery. Meta's `effective_status`
 * is the actual delivery state, accounting for parent-entity pausing (an ad
 * set can be status=ACTIVE while effective_status=CAMPAIGN_PAUSED), ad
 * review/policy (PENDING_REVIEW, DISAPPROVED, PREAPPROVED), delivery issues
 * (WITH_ISSUES), billing (PENDING_BILLING_INFO), and account-level
 * restrictions (ACCOUNT_DISABLED). See schema.phase15.js for where this is
 * stored and metaApiClient.js for where it's fetched.
 *
 * Never reduces these to a binary active/inactive -- every known Meta
 * effective_status is named explicitly, with its own label and lifecycle
 * recommendation action, per Meta's own product terminology.
 */

// Meta's documented effective_status enum for campaigns/ad sets/ads (Meta
// Marketing API `effective_status` field). Every value is treated
// explicitly -- an unrecognized value (a future Meta addition, or the
// legacy pre-Phase-15 rows that have no effective_status yet) falls back
// to UNKNOWN, never silently assumed to be delivering.
const LIFECYCLE = {
  ACTIVE: {
    label: 'Active',
    isDelivering: true,
    recommendationAction: null, // normal AI pipeline runs; no lifecycle action needed
  },
  PAUSED: {
    label: 'Paused',
    isDelivering: false,
    recommendationAction: 'Resume',
    message: 'This entity is paused.',
  },
  CAMPAIGN_PAUSED: {
    label: 'Campaign Paused',
    isDelivering: false,
    recommendationAction: 'Resume',
    message: 'This entity is not delivering because its parent campaign is paused.',
  },
  ADSET_PAUSED: {
    label: 'Ad Set Paused',
    isDelivering: false,
    recommendationAction: 'Resume',
    message: 'This entity is not delivering because its parent ad set is paused.',
  },
  ARCHIVED: {
    label: 'Archived',
    isDelivering: false,
    recommendationAction: 'Duplicate',
    message: 'This entity is archived. Duplicate it to run this again.',
  },
  DELETED: {
    label: 'Deleted',
    isDelivering: false,
    recommendationAction: 'No Action Required',
    message: 'This entity has been deleted.',
  },
  IN_PROCESS: {
    label: 'In Process',
    isDelivering: false,
    recommendationAction: 'No Action Required',
    message: 'This entity is still being processed by Meta.',
  },
  WITH_ISSUES: {
    label: 'With Issues',
    isDelivering: false,
    recommendationAction: 'Review',
    message: 'Meta has flagged a delivery issue affecting this entity.',
  },
  DISAPPROVED: {
    label: 'Disapproved',
    isDelivering: false,
    recommendationAction: 'Fix Policy',
    message: 'This entity was rejected by Meta ad review for a policy violation.',
  },
  PENDING_REVIEW: {
    label: 'Pending Review',
    isDelivering: false,
    recommendationAction: 'No Action Required',
    message: 'This entity is awaiting Meta ad review.',
  },
  PREAPPROVED: {
    label: 'Preapproved',
    isDelivering: false,
    recommendationAction: 'No Action Required',
    message: 'This entity is approved ahead of its scheduled start and will deliver automatically.',
  },
  PENDING_BILLING_INFO: {
    label: 'Pending Billing Info',
    isDelivering: false,
    recommendationAction: 'Review',
    message: 'This entity is not delivering because of a billing issue on the account.',
  },
  ACCOUNT_DISABLED: {
    label: 'Account Disabled',
    isDelivering: false,
    recommendationAction: 'Review',
    message: 'This entity is not delivering because the ad account has been disabled.',
  },
  UNKNOWN: {
    label: 'Unknown',
    isDelivering: false,
    recommendationAction: 'Review',
    message: 'This entity\'s real delivery status could not be determined from Meta -- review it directly in Meta Ads Manager.',
  },
};

/**
 * Resolve the lifecycle descriptor for a raw Meta effective_status string.
 * Never infers from spend/impressions -- input must be the real Meta value
 * (or null/undefined, which resolves to UNKNOWN, not ACTIVE).
 */
function resolveLifecycle(effectiveStatus) {
  if (!effectiveStatus) return { code: 'UNKNOWN', ...LIFECYCLE.UNKNOWN };
  const code = String(effectiveStatus).toUpperCase().trim();
  const entry = LIFECYCLE[code];
  if (!entry) return { code: 'UNKNOWN', ...LIFECYCLE.UNKNOWN, label: `Unknown (${code})` };
  return { code, ...entry };
}

/**
 * @returns {boolean} true only when Meta itself reports this entity as
 *   actually delivering (effective_status === 'ACTIVE').
 */
function isDelivering(effectiveStatus) {
  return resolveLifecycle(effectiveStatus).isDelivering;
}

module.exports = { LIFECYCLE, resolveLifecycle, isDelivering };
