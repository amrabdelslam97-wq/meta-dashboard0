/**
 * Mock Data Guard
 *
 * ?mock=true is a development/demo convenience that returns fabricated
 * metrics shaped like real Meta Insights data, instead of real data. It
 * must never be reachable once the app is running with NODE_ENV=production
 * — the previous absence of any environment gate on this parameter meant
 * fabricated data was reachable in every environment, indistinguishable at
 * the network layer from a real Meta-backed response.
 */

function isMockRequested(req) {
  return req.query.mock === 'true';
}

/**
 * If mock data was requested while running in production, write a 403
 * response and return true (caller must then `return` immediately).
 * Otherwise returns false and the caller proceeds normally.
 */
function rejectMockInProduction(req, res) {
  if (isMockRequested(req) && process.env.NODE_ENV === 'production') {
    res.status(403).json({
      error: 'Mock data is disabled in production',
      message: 'The mock=true parameter is only available when NODE_ENV is not "production".',
    });
    return true;
  }
  return false;
}

module.exports = { isMockRequested, rejectMockInProduction };
