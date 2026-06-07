// ============================================================
// REGIME DETECTOR (FIXED — Phase 2)
// Now instantiable with detect() and reset() instance methods
// ============================================================

class RegimeDetector {
  constructor() {
    // No persistent state needed; classification is stateless per-call
  }

  /**
   * Instance method called by InstrumentEngine
   * @param {Array} candles — candle array (used for ATR calc if indicators lack atr14_MA20)
   * @param {Object} indicators — full indicator snapshot from calculateIndicators()
   * @returns {Object} { trend, strength, regime, ... }
   */
  detect(candles, indicators) {
    const atr14 = indicators?.atr14;
    const atr14_MA20 = indicators?.atr14_MA20;
    const ivRank = indicators?.ivRank ?? null;

    // If indicators already have regime classification, use it
    if (indicators?.regime) {
      return {
        trend: indicators.regime.trend || 'NEUTRAL',
        strength: indicators.regime.strength || 0,
        ...indicators.regime,
      };
    }

    // Fallback: compute from ATR
    const classification = RegimeDetector.classifyRegime(atr14, atr14_MA20, ivRank);
    return {
      trend: classification.regime === 'NORMAL' ? 'NEUTRAL' :
             classification.regime === 'HIGH' || classification.regime === 'ELEVATED' ? 'VOLATILE' :
             classification.regime === 'EXTREME' ? 'EXTREME' :
             classification.regime === 'DEAD' ? 'DEAD' : 'NEUTRAL',
      strength: classification.scorePenalty || 0,
      ...classification,
    };
  }

  reset() {
    // Stateless — nothing to reset
  }

  /**
   * Calculate Average True Range (ATR) from candle data
   * @param {Array} candles — Array of {open, high, low, close}
   * @param {number} period — ATR period (default 14)
   * @returns {number|null} ATR value or null if insufficient data
   */
  static calcATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr);
    }

    if (trs.length < period) return null;

    // Wilder's smoothing
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }

    return parseFloat(atr.toFixed(2));
  }

  /**
   * Classify volatility regime based on ATR and its moving average
   * @param {number} atr14 — Current 14-period ATR
   * @param {number} atr14_MA20 — 20-period SMA of ATR14
   * @param {number|null} ivRank — Optional IV rank (0-100)
   * @returns {Object} Regime classification
   */
  static classifyRegime(atr14, atr14_MA20, ivRank = null) {
    if (!Number.isFinite(atr14) || !Number.isFinite(atr14_MA20)) {
      return {
        regime: 'NORMAL',
        targetMultiplier: 1.0,
        scorePenalty: 0,
        atr14,
        atr14_MA20,
      };
    }

    const ratio = atr14_MA20 > 0 ? atr14 / atr14_MA20 : 1;
    const atrPct = atr14_MA20 > 0 ? ((atr14 - atr14_MA20) / atr14_MA20) * 100 : 0;

    // EXTREME: ATR > 2.5x its MA or IV rank > 90
    if (ratio > 2.5 || (ivRank !== null && ivRank > 90)) {
      return {
        regime: 'EXTREME',
        targetMultiplier: 0.0,
        scorePenalty: 100,
        atr14,
        atr14_MA20,
        ratio,
        ivRank,
      };
    }

    // DEAD: ATR < 0.3x its MA (extremely compressed)
    if (ratio < 0.3) {
      return {
        regime: 'DEAD',
        targetMultiplier: 0.0,
        scorePenalty: 100,
        atr14,
        atr14_MA20,
        ratio,
        ivRank,
      };
    }

    // HIGH: ATR > 1.8x its MA or IV rank > 75
    if (ratio > 1.8 || (ivRank !== null && ivRank > 75)) {
      return {
        regime: 'HIGH',
        targetMultiplier: 1.5,
        scorePenalty: 0,
        atr14,
        atr14_MA20,
        ratio,
        ivRank,
      };
    }

    // ELEVATED: ATR > 1.3x its MA or IV rank > 60
    if (ratio > 1.3 || (ivRank !== null && ivRank > 60)) {
      return {
        regime: 'ELEVATED',
        targetMultiplier: 1.0,
        scorePenalty: 0.15,
        atr14,
        atr14_MA20,
        ratio,
        ivRank,
      };
    }

    // NORMAL
    return {
      regime: 'NORMAL',
      targetMultiplier: 1.0,
      scorePenalty: 0,
      atr14,
      atr14_MA20,
      ratio,
      ivRank,
    };
  }
}

module.exports = RegimeDetector;
