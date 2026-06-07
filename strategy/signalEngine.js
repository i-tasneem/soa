// ============================================================
// SIGNAL ENGINE
// Generates BUY_CE / BUY_PE signals based on multi-factor analysis
// ============================================================

const { STATES } = require('./marketStateEngine');

class SignalEngine {
  constructor() {
    this.signals = [];
    this.maxSignals = 5;
    this.cooldownMs = 300000; // 5 minutes
    this.lastSignalTime = 0;
    this.signalCount = 0;
    this.tradesToday = 0;
    this.maxTrades = 3;
    this._lastResetDate = null;
  }

  evaluate(ctx) {
    this._checkDayReset();

    const { indicators, marketState, oiAnalysis, regime, price, timestamp, profile } = ctx;

    if (!indicators || !marketState || !oiAnalysis) return null;

    // Check cooldown
    if (timestamp - this.lastSignalTime < this.cooldownMs) return null;

    // Check max signals
    if (this.signalCount >= this.maxSignals) return null;

    // Check max trades
    if (this.tradesToday >= this.maxTrades) return null;

    // Check optimal windows
    if (!this._inOptimalWindow(timestamp, profile)) return null;

    // Check lunch ban
    if (this._isLunchBan(timestamp, profile)) return null;

    // Check first 15 min ban
    if (profile?.first15MinBan && this._isFirst15Min(timestamp)) return null;

    // Calculate confidence score
    let score = 0;
    let factors = [];
    let type = null;

    const { ema5, ema9, ema21, vwap, rsi, bb, atr } = indicators;
    const { state, confidence: stateConfidence } = marketState;
    const { ceBuyConfirmed, peBuyConfirmed, oiBullish, oiBearish, imbalanceBias } = oiAnalysis;

    // EMA alignment
    if (ema5 > ema9 && ema9 > ema21) {
      score += 15;
      factors.push({ name: 'Bullish EMA', score: 15 });
    } else if (ema5 < ema9 && ema9 < ema21) {
      score -= 15;
      factors.push({ name: 'Bearish EMA', score: -15 });
    }

    // VWAP position
    if (price > vwap) {
      score += 10;
      factors.push({ name: 'Above VWAP', score: 10 });
    } else if (price < vwap) {
      score -= 10;
      factors.push({ name: 'Below VWAP', score: -10 });
    }

    // RSI confirmation
    if (rsi > 55 && rsi < 70) {
      score += 10;
      factors.push({ name: 'RSI bullish zone', score: 10 });
    } else if (rsi < 45 && rsi > 30) {
      score -= 10;
      factors.push({ name: 'RSI bearish zone', score: -10 });
    }

    // Market state
    if (state === STATES.TRENDING_BULLISH) {
      score += 15;
      factors.push({ name: 'Bullish trend', score: 15 });
    } else if (state === STATES.TRENDING_BEARISH) {
      score -= 15;
      factors.push({ name: 'Bearish trend', score: -15 });
    } else if (state === STATES.BREAKOUT) {
      score += (stateConfidence > 70 ? 20 : 10);
      factors.push({ name: 'Breakout', score: stateConfidence > 70 ? 20 : 10 });
    } else if (state === STATES.SIDEWAYS) {
      score -= 10;
      factors.push({ name: 'Sideways market', score: -10 });
    } else if (state === STATES.VOLATILE) {
      score -= 5;
      factors.push({ name: 'Volatile market', score: -5 });
    }

    // OI confirmation
    if (ceBuyConfirmed) {
      score += 15;
      factors.push({ name: 'OI bullish', score: 15 });
    }
    if (peBuyConfirmed) {
      score -= 15;
      factors.push({ name: 'OI bearish', score: -15 });
    }
    if (oiBullish) {
      score += 10;
      factors.push({ name: 'OI buildup bullish', score: 10 });
    }
    if (oiBearish) {
      score -= 10;
      factors.push({ name: 'OI buildup bearish', score: -10 });
    }

    // Imbalance
    if (imbalanceBias === 'BULLISH') {
      score += 8;
      factors.push({ name: 'OI imbalance bullish', score: 8 });
    } else if (imbalanceBias === 'BEARISH') {
      score -= 8;
      factors.push({ name: 'OI imbalance bearish', score: -8 });
    }

    // Regime
    if (regime) {
      if (regime.trend === 'UP' && regime.strength > 0.6) {
        score += 10;
        factors.push({ name: 'Strong uptrend regime', score: 10 });
      } else if (regime.trend === 'DOWN' && regime.strength > 0.6) {
        score -= 10;
        factors.push({ name: 'Strong downtrend regime', score: -10 });
      }
    }

    // ATR check - avoid low volatility
    if (atr && atr < (price * 0.001)) {
      score -= 10;
      factors.push({ name: 'Low volatility', score: -10 });
    }

    // Determine signal type
    if (score >= 40) {
      type = 'BUY_CE';
    } else if (score <= -40) {
      type = 'BUY_PE';
    }

    if (!type) return null;

    const confidence = Math.min(95, Math.abs(score) + 50);
    const strength = confidence >= 85 ? 'STRONG' : confidence >= 70 ? 'MODERATE' : 'WEAK';

    const signal = {
      id: `SIG_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      confidence,
      strength,
      score,
      factors,
      price,
      timestamp,
      timeStr: this._formatTime(timestamp),
      signalNum: this.signalCount + 1,
      indicators: {
        ema5,
        ema9,
        ema21,
        vwap,
        rsi,
        bb: bb ? { bw: bb.bw, squeeze: bb.squeeze } : null,
        atr,
      },
      marketState: {
        state: marketState.state,
        confidence: marketState.confidence,
      },
      oi: {
        pcr: oiAnalysis.pcr,
        pcrBias: oiAnalysis.pcrBias,
        imbalanceBias: oiAnalysis.imbalanceBias,
      },
    };

    this.signals.push(signal);
    this.signalCount++;
    this.lastSignalTime = timestamp;

    return signal;
  }

  _checkDayReset() {
    const now = new Date();
    const today = now.toDateString();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this.signalCount = 0;
      this.tradesToday = 0;
      this.signals = [];
      this.lastSignalTime = 0;
    }
  }

  _inOptimalWindow(timestamp, profile) {
    const windows = profile?.optimalWindows || ['09:30-11:30', '13:30-15:00'];
    const date = new Date(timestamp);
    const h = date.getHours();
    const m = date.getMinutes();
    const mins = h * 60 + m;

    for (const w of windows) {
      const [s, e] = w.split('-');
      const [sh, sm] = s.split(':').map(Number);
      const [eh, em] = e.split(':').map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      if (mins >= start && mins <= end) return true;
    }
    return false;
  }

  _isLunchBan(timestamp, profile) {
    if (!profile?.lunchBanStart || !profile?.lunchBanEnd) return false;
    const date = new Date(timestamp);
    const h = date.getHours();
    const m = date.getMinutes();
    const mins = h * 60 + m;
    const [sh, sm] = profile.lunchBanStart.split(':').map(Number);
    const [eh, em] = profile.lunchBanEnd.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return mins >= start && mins <= end;
  }

  _isFirst15Min(timestamp) {
    const date = new Date(timestamp);
    const h = date.getHours();
    const m = date.getMinutes();
    return h === 9 && m < 30;
  }

  _formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  onTradeOpen() {
    this.tradesToday++;
  }

  onTradeClose() {
    // Trade closed - no count change
  }

  reset() {
    this.signals = [];
    this.signalCount = 0;
    this.tradesToday = 0;
    this.lastSignalTime = 0;
    this._lastResetDate = null;
    console.log('🔄 Signal engine reset');
  }

  getSignals() {
    return [...this.signals];
  }
}

module.exports = new SignalEngine();
module.exports.SignalEngine = SignalEngine;
