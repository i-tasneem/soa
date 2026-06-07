// ============================================================
// EARLY ENTRY DETECTOR
// Detects pre-signal conditions for early warning
// ============================================================

class EarlyEntryDetector {
  constructor() {
    this.conditions = [];
    this.maxConditions = 20;
    this._lastResetDate = null;
  }

  check(ctx) {
    const { indicators, marketState, oiAnalysis, price, timestamp } = ctx;
    if (!indicators || !marketState || !oiAnalysis) return null;

    const { ema5, ema9, ema21, vwap, rsi, bb } = indicators;
    const { state } = marketState;
    const { ceBuyConfirmed, peBuyConfirmed } = oiAnalysis;

    let score = 0;
    let factors = [];
    let type = null;

    // Early EMA alignment (not yet fully aligned)
    if (ema5 > ema9 && ema9 < ema21) {
      score += 5;
      factors.push({ name: 'Early bullish EMA', score: 5 });
    } else if (ema5 < ema9 && ema9 > ema21) {
      score -= 5;
      factors.push({ name: 'Early bearish EMA', score: -5 });
    }

    // Price near VWAP
    const vwapDist = Math.abs(price - vwap) / vwap;
    if (vwapDist < 0.001) {
      score += 3;
      factors.push({ name: 'Price near VWAP', score: 3 });
    }

    // RSI approaching zones
    if (rsi > 50 && rsi < 55) {
      score += 3;
      factors.push({ name: 'RSI approaching bullish', score: 3 });
    } else if (rsi < 50 && rsi > 45) {
      score -= 3;
      factors.push({ name: 'RSI approaching bearish', score: -3 });
    }

    // OI early signals
    if (ceBuyConfirmed) {
      score += 5;
      factors.push({ name: 'Early OI bullish', score: 5 });
    }
    if (peBuyConfirmed) {
      score -= 5;
      factors.push({ name: 'Early OI bearish', score: -5 });
    }

    if (score >= 12) {
      type = 'EARLY_CE';
    } else if (score <= -12) {
      type = 'EARLY_PE';
    }

    if (!type) return null;

    const condition = {
      id: `EARLY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      score,
      factors,
      price,
      timestamp,
      timeStr: this._formatTime(timestamp),
    };

    this.conditions.push(condition);
    if (this.conditions.length > this.maxConditions) this.conditions.shift();

    return condition;
  }

  _formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  reset() {
    this.conditions = [];
    this._lastResetDate = null;
    console.log('🔄 Early entry detector reset');
  }

  getConditions() {
    return [...this.conditions];
  }
}

module.exports = new EarlyEntryDetector();
module.exports.EarlyEntryDetector = EarlyEntryDetector;
