/**
 * AI Marketing Advisor Routes — Phase 42 (Decision Intelligence)
 *
 * Dedicated surface for the advisor bundle creativeLibrary.getCreativeDetails()
 * now computes (root cause, priorities, strategic advice, risk, scaling/pause
 * advice, benchmark comparison, evolution stages) plus account/campaign
 * pattern learning. Purely additive -- does not change any existing route's
 * response shape; the same `advisor` object is also embedded in
 * GET /creative-intelligence/:adId for callers that already consume that
 * bundle.
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../middleware/errorHandler');

const creativeLibrary = require('../../services/creativeLibrary');
const advisorLearningEngine = require('../../services/advisorLearningEngine');

router.get('/creative/:adId', asyncHandler(async (req, res) => {
  const details = await creativeLibrary.getCreativeDetails(req.params.adId, { useMock: req.query.mock === 'true' });
  if (!details) return res.status(404).json({ error: 'Ad not found' });

  if (details.analyzed === false) {
    return res.json({ data: { meta_ad_id: details.meta_ad_id, analyzed: false, reason: details.reason } });
  }

  return res.json({
    data: {
      meta_ad_id: details.meta_ad_id,
      analyzed: true,
      scores: details.scores,
      fatigue: details.fatigue,
      ...details.advisor,
    },
  });
}));

router.get('/account/:accountId/learning', asyncHandler(async (req, res) => {
  const learning = advisorLearningEngine.getAccountCreativeLearning(req.params.accountId);
  return res.json({ data: learning });
}));

router.get('/campaign/:campaignId/learning', asyncHandler(async (req, res) => {
  const learning = advisorLearningEngine.getCampaignCreativeLearning(req.params.campaignId);
  return res.json({ data: learning });
}));

module.exports = router;
