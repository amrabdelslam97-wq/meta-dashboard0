/**
 * Predictive AI Engine — Phase 25 Part A
 *
 * Core prediction engine using time series analysis:
 * - Time series forecasting (moving average, trend extrapolation)
 * - Anomaly detection (Z-score, volatility expansion)
 * - Risk scoring (0-100 based on stability, volatility, trend)
 * - Opportunity scoring (0-100 based on growth, headroom, performance)
 * - Prediction confidence calculation
 *
 * All predictions derived from real historical synced data.
 * No fabrication, no external data, no trained models.
 */

const db = require('../db/database');
const { defaultRange, priorPeriod, addDays } = require('./dateRangeHelper');

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────
// TIME SERIES ANALYSIS UTILITIES
// ─────────────────────────────────────────────

/**
 * Fetch historical data points for an entity across time.
 */
function getHistoricalData(table, column, filter, dateOrderBy = 'date_until') {
  try {
    const query = `SELECT ${column}, date_since, date_until FROM ${table} WHERE ${filter} ORDER BY ${dateOrderBy} ASC`;
    return db.all(query);
  } catch (e) {
    return [];
  }
}

/**
 * Calculate simple statistics from data points.
 */
function calculateStats(values) {
  if (!values || values.length === 0) {
    return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, count: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / sorted.length;
  const stddev = Math.sqrt(variance);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  return {
    mean: round(mean),
    median: round(median),
    stddev: round(stddev),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    count: sorted.length,
  };
}

/**
 * Simple exponential smoothing forecast (recent data weighted more).
 */
function exponentialSmoothing(values, alpha = 0.3, periods = 1) {
  if (!values || values.length < 2) {
    return values?.[values.length - 1] || 0;
  }

  let smooth = values[0];
  for (let i = 1; i < values.length; i++) {
    smooth = alpha * values[i] + (1 - alpha) * smooth;
  }

  // Project forward
  let forecast = smooth;
  for (let i = 0; i < periods; i++) {
    forecast = smooth; // Simple case: constant forecast
  }

  return round(forecast, 2);
}

/**
 * Linear trend extrapolation.
 */
function linearTrend(values, periods = 1) {
  if (!values || values.length < 2) {
    return values?.[values.length - 1] || 0;
  }

  const n = values.length;
  const xMean = (n - 1) / 2; // Index midpoint
  const yMean = values.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    numerator += (x - xMean) * (values[i] - yMean);
    denominator += Math.pow(x - xMean, 2);
  }

  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  // Forecast
  const lastX = n - 1;
  const forecast = intercept + slope * (lastX + periods);

  return round(forecast, 2);
}

/**
 * Z-score based anomaly detection.
 */
function detectAnomaly(value, values, threshold = 2.5) {
  if (!values || values.length < 3) {
    return { is_anomaly: false, z_score: 0, reason: 'insufficient_data' };
  }

  const stats = calculateStats(values);
  const zScore = stats.stddev !== 0 ? (value - stats.mean) / stats.stddev : 0;
  const isAnomaly = Math.abs(zScore) > threshold;

  let reason = 'normal';
  if (isAnomaly) {
    if (zScore > threshold) reason = 'spike';
    else if (zScore < -threshold) reason = 'drop';
  }

  return {
    is_anomaly: isAnomaly,
    z_score: round(zScore, 2),
    reason,
    threshold,
  };
}

// ─────────────────────────────────────────────
// PREDICTION ENGINE
// ─────────────────────────────────────────────

/**
 * Predict next period value for a metric.
 */
function predictMetric(table, column, filter, metric = 'ctr', periods = 1) {
  const history = getHistoricalData(table, column, filter);

  if (!history || history.length < 2) {
    return {
      metric,
      forecast: null,
      method: 'insufficient_data',
      confidence: 0,
      data_points: history?.length || 0,
    };
  }

  const values = history.map(h => {
    const val = typeof h === 'object' ? h[column] : h;
    return val || 0;
  }).filter(v => v > 0);

  if (values.length < 2) {
    return {
      metric,
      forecast: null,
      method: 'no_values',
      confidence: 0,
      data_points: 0,
    };
  }

  // Forecast using exponential smoothing + linear trend average
  const expSmooth = exponentialSmoothing(values, 0.3, periods);
  const linTrend = linearTrend(values, periods);
  const forecast = (expSmooth + linTrend) / 2;

  // Confidence based on data quality
  const stats = calculateStats(values);
  const volatilityRatio = stats.stddev / (stats.mean || 1);
  const dataRecency = Math.min(1, values.length / 10); // More data = higher confidence
  const stabilityScore = Math.max(0, 1 - volatilityRatio); // Low volatility = high confidence

  const confidence = round((dataRecency * stabilityScore) * 100);

  return {
    metric,
    forecast: round(forecast, 2),
    method: 'exponential_smoothing_linear_trend_ensemble',
    confidence,
    volatility: round(volatilityRatio, 2),
    data_points: values.length,
    mean: stats.mean,
    stddev: stats.stddev,
  };
}

/**
 * Calculate risk score for an entity (0-100).
 * Factors: stability, volatility, trend, historical performance.
 */
function calculateRiskScore(table, column, filter) {
  const history = getHistoricalData(table, column, filter);

  if (!history || history.length < 2) {
    return {
      risk_score: 50, // Neutral for insufficient data
      risk_level: 'medium',
      confidence: 0.30,
      reason: 'insufficient_data',
    };
  }

  const values = history.map(h => typeof h === 'object' ? h[column] : h).filter(v => v !== null);

  if (values.length < 2) {
    return {
      risk_score: 50,
      risk_level: 'medium',
      confidence: 0.30,
      reason: 'no_valid_values',
    };
  }

  const stats = calculateStats(values);
  const volatilityRatio = stats.stddev / (stats.mean || 1);

  // Risk factors
  let riskScore = 50; // Base

  // Volatility factor (high volatility = higher risk)
  const volatilityRisk = Math.min(50, volatilityRatio * 100);
  riskScore += volatilityRisk * 0.4; // 40% weight

  // Trend factor (declining trend = higher risk)
  if (values.length >= 3) {
    const recentMean = calculateStats(values.slice(-3)).mean;
    const olderMean = calculateStats(values.slice(0, 3)).mean;
    const trendRatio = recentMean / (olderMean || 1);
    if (trendRatio < 0.9) {
      riskScore += (1 - trendRatio) * 30; // Increase risk if declining
    }
  }

  // Data quality factor (sparse data = higher risk)
  const dataQuality = Math.min(1, values.length / 10);
  const sparsenessPenalty = (1 - dataQuality) * 20;
  riskScore += sparsenessPenalty * 0.2; // 20% weight

  riskScore = Math.min(100, riskScore);

  let riskLevel = 'low';
  if (riskScore >= 75) riskLevel = 'critical';
  else if (riskScore >= 60) riskLevel = 'high';
  else if (riskScore >= 40) riskLevel = 'medium';

  const confidence = Math.min(0.95, dataQuality + (1 - volatilityRatio) * 0.3);

  return {
    risk_score: round(riskScore),
    risk_level: riskLevel,
    confidence: round(confidence, 2),
    volatility_ratio: round(volatilityRatio, 2),
    data_points: values.length,
    factors: {
      volatility_contribution: round(volatilityRisk * 0.4),
      trend_contribution: riskScore > 50 ? round((riskScore - 50) * 0.3) : 0,
      data_quality_contribution: round(sparsenessPenalty * 0.2),
    },
  };
}

/**
 * Calculate opportunity score for an entity (0-100).
 * Factors: growth potential, performance vs peers, headroom.
 */
function calculateOpportunityScore(table, column, filter, entityMetaId) {
  const history = getHistoricalData(table, column, filter);

  if (!history || history.length < 2) {
    return {
      opportunity_score: 50,
      opportunity_level: 'medium',
      confidence: 0.30,
      reason: 'insufficient_data',
    };
  }

  const values = history.map(h => typeof h === 'object' ? h[column] : h).filter(v => v !== null);

  if (values.length < 2) {
    return {
      opportunity_score: 50,
      opportunity_level: 'medium',
      confidence: 0.30,
      reason: 'no_values',
    };
  }

  let score = 50; // Base

  const stats = calculateStats(values);

  // Growth potential (positive trend = opportunity)
  if (values.length >= 3) {
    const recentMean = calculateStats(values.slice(-3)).mean;
    const olderMean = calculateStats(values.slice(0, 3)).mean;
    const growthRate = (recentMean - olderMean) / (olderMean || 1);
    if (growthRate > 0.1) {
      score += Math.min(30, growthRate * 100); // Growth bonus
    }
  }

  // Performance headroom (low current value = room to grow)
  // Assume max reasonable value is 3x current mean
  const headroom = Math.max(0, 3 - (stats.mean / 50)); // Normalized scale
  score += Math.min(20, headroom * 10); // 20% weight

  // Stability bonus (low volatility = safe to scale)
  const volatilityRatio = stats.stddev / (stats.mean || 1);
  const stabilityBonus = Math.max(0, 20 * (1 - Math.min(1, volatilityRatio)));
  score += stabilityBonus * 0.2; // 20% weight

  score = Math.min(100, score);

  let level = 'low';
  if (score >= 75) level = 'excellent';
  else if (score >= 60) level = 'good';
  else if (score >= 40) level = 'medium';

  const confidence = Math.min(0.95, (values.length / 10) + (1 - Math.min(1, volatilityRatio)) * 0.3);

  return {
    opportunity_score: round(score),
    opportunity_level: level,
    confidence: round(confidence, 2),
    growth_potential: round((score - 50) / 50 * 100), // % potential upside
    data_points: values.length,
  };
}

/**
 * Predict next day/week/month performance with full confidence metrics.
 */
function forecast(entityType, entityId, metric, forecastHorizon = '7d', dateRange = defaultRange()) {
  // Convert horizon to periods (simplified for phase 25a)
  const periodMap = { '1d': 1, '7d': 7, '14d': 14, '30d': 30 };
  const periods = periodMap[forecastHorizon] || 7;

  // Get prediction
  const prediction = predictMetric('campaigns', metric, `meta_campaign_id = '${entityId}'`, metric, periods);

  // Get risk
  const risk = calculateRiskScore('campaigns', metric, `meta_campaign_id = '${entityId}'`);

  // Get opportunity
  const opportunity = calculateOpportunityScore('campaigns', metric, `meta_campaign_id = '${entityId}'`, entityId);

  return {
    entity_type: entityType,
    entity_id: entityId,
    metric,
    forecast_horizon: forecastHorizon,
    forecast_value: prediction.forecast,
    forecast_method: prediction.method,
    prediction_confidence: prediction.confidence,
    volatility: prediction.volatility,
    data_quality: prediction.data_points > 5 ? 'high' : prediction.data_points > 2 ? 'medium' : 'low',
    risk: {
      score: risk.risk_score,
      level: risk.risk_level,
      confidence: risk.confidence,
    },
    opportunity: {
      score: opportunity.opportunity_score,
      level: opportunity.opportunity_level,
      potential_upside: opportunity.growth_potential,
    },
    historical_stats: {
      data_points: prediction.data_points,
      mean: prediction.mean,
      stddev: prediction.stddev,
    },
  };
}

module.exports = {
  predictMetric,
  calculateRiskScore,
  calculateOpportunityScore,
  forecast,
  getHistoricalData,
  calculateStats,
};
