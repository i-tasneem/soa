// ============================================================
// ABORT ENGINE
// Detects conditions that should abort a trade setup
// ============================================================

class AbortEngine {
  constructor() {
    this.aborts = [];
    this.maxAborts = 50;
    this._lastResetDate = null;
  }

  check(ctx) {
    const { price, indicators, marketState, oiAnalysis, regime, signal, timestamp } = ctx;
    if (!indicators || !marketState || !oiAnalysis) return null;

    const { ema5, ema9, ema21, vwap, rsi, bb, atr } = indicators;
    const { state, confidence } = marketState;
    const { isPinned, nearPin, pcrTrend, oiVelocity } = oiAnalysis;

    let abort = null;
    let reasons = [];

    // Pin zone abort
    if (isPinned || nearPin) {
      reasons.push('Price pinned near OI wall');
    }

    // Low confidence state
    if (confidence < 40) {
      reasons.push('Low market state confidence');
    }

    // Extreme RSI
    if (rsi > 75 || rsi < 25) {
      reasons.push('Extreme RSI — potential reversal');
    }

    // BB squeeze with no direction
    if (bb?.squeeze && state === 'SIDEWAYS') {
      reasons.push('BB squeeze in sideways market');
    }

    // Rapid PCR change
    if (pcrTrend === 'RISING_FAST' || pcrTrend === 'FALLING_FAST') {
      reasons.push('Rapid PCR change — unstable');
    }

    // High OI velocity
    if (oiVelocity && (Math.abs(oiVelocity.cePerMin) > 5000 || Math.abs(oiVelocity.pePerMin) > 5000)) {
      reasons.push('High OI velocity — volatile');
    }

    // ATR too low
    if (atr && atr < (price * 0.0005)) {
      reasons.push('Extremely low volatility');
    }

    if (reasons.length >= 3) {
      abort = {
        id: `ABORT_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        reasons,
        price,
        timestamp,
        timeStr: this._formatTime(timestamp),
        severity: reasons.length >= 4 ? 'HIGH' : 'MEDIUM',
      };

      this.aborts.push(abort);
      if (this.aborts.length > this.maxAborts) this.aborts.shift();
    }

    return abort;
  }

  _formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  reset() {
    this.aborts = [];
    this._lastResetDate = null;
    console.log('🔄 Abort engine reset');
  }

  getAborts() {
    return [...this.aborts];
  }
}

module.exports = AbortEngine;
module.exports.AbortEngine = AbortEngine;
