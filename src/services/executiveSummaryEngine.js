/**
 * Executive Summary Engine — Product Completion Mode, Milestone 1
 *
 * Assembles one plain-language summary string from data the existing
 * pipeline already computes (objective, health score, diagnosis, rule
 * engine decisions, recommendations, alerts). Template-based and
 * deterministic -- no LLM, no generated prose beyond fixed sentence
 * fragments filled in with real field values. Presentation-layer only,
 * matching comparisonEngine.js's "no new business logic, just assembly"
 * style -- no DB access, no side effects.
 */

function formatObjectiveLabel(objective) {
  if (!objective) return 'This';
  return `This ${objective.replace(/_/g, ' ')}`;
}

/**
 * @param {object} params
 *   objective          - campaign.objective
 *   healthScore        - number|null
 *   healthStatus       - string|null
 *   diagnosis          - diagnosisEngine.diagnoseCampaign() output, or null
 *   ruleEngineDecisions - decisionEngine.decisionsFromRuleEngine() output, or []
 *   recommendations    - intelligence.recommendations, or []
 *   alerts             - intelligence.alerts, or []
 * @returns {string}
 */
function buildExecutiveSummary({
  objective, healthScore = null, healthStatus = null, diagnosis = null,
  ruleEngineDecisions = [], recommendations = [], alerts = [],
} = {}) {
  // Lifecycle fix: a non-delivering entity (paused/archived/disapproved/
  // pending review/etc.) must never be summarized as if its performance
  // were being scored -- the generic "is currently <status> (<score>/100)"
  // framing below assumes live delivery.
  if (healthStatus === 'not_delivering' || diagnosis?.status === 'not_delivering') {
    const lifecycleRec = recommendations.find(r => r.rule_code?.startsWith('LIFECYCLE_'));
    return [
      `${formatObjectiveLabel(objective)} campaign is currently not delivering.`,
      lifecycleRec ? `Recommended action: ${lifecycleRec.recommendation_title}.` : null,
    ].filter(Boolean).join(' ');
  }

  const parts = [];

  parts.push(
    `${formatObjectiveLabel(objective)} campaign is currently ` +
    `${healthStatus || 'unscored'} (${healthScore != null ? healthScore + '/100' : 'no score yet'}).`
  );

  if (diagnosis && diagnosis.status === 'diagnosed' && diagnosis.primaryDelta) {
    const pct = diagnosis.primaryDelta.delta_pct;
    const direction = pct > 0 ? 'increased' : pct < 0 ? 'decreased' : 'stayed flat';
    parts.push(`${diagnosis.primaryLabel} has ${direction} ${Math.abs(pct)}%.`);

    if (diagnosis.category && diagnosis.category !== 'unexplained' && diagnosis.category !== 'unclassified') {
      parts.push(`Root cause: ${diagnosis.category.replace(/_/g, ' ')}.`);
    } else if (diagnosis.summary) {
      parts.push(diagnosis.summary);
    }
  } else if (diagnosis && diagnosis.status === 'insufficient_data') {
    parts.push('Not enough traffic yet to diagnose what is driving performance.');
  }

  const activeCount = ruleEngineDecisions.length + recommendations.length + alerts.length;
  if (activeCount === 0) {
    parts.push('No active Decision, Recommendation, or Alert for this campaign right now.');
  } else {
    const topDecision = [...ruleEngineDecisions].sort(
      (a, b) => (b.priority_score || 0) - (a.priority_score || 0)
    )[0];
    if (topDecision) {
      parts.push(
        `Top priority action: ${topDecision.suggested_action} ` +
        `(${topDecision.priority} priority, ${topDecision.confidence} confidence).`
      );
    }
    parts.push(
      `${activeCount} active finding(s) — ${ruleEngineDecisions.length} rule-based, ` +
      `${recommendations.length} recommendation(s), ${alerts.length} alert(s).`
    );
  }

  return parts.join(' ');
}

module.exports = { buildExecutiveSummary };
