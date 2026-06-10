// ============================================================
// SIGNAL ENGINE v7 — Stabilized
// Changes from v6:
// 1. Per-direction cooldown (CE vs PE) instead of global
// 2. Composite deduplication key: instrument:type:strike:hour
// 3. Bounded signals array (ring buffer, max 10 per instrument)
// 4. Signal lifecycle states: NEW → ACTIVE → CLOSED → ARCHIVED
// 5. Score factor logging for audit trail
// STRATEGY LOGIC UNCHANGED — only dedup, lifecycle, and bounds added
// ============================================================

const logger = require('../logger');

class SignalEngine {
  constructor() {
    this.signals = []; // bounded ring buffer
    this.maxSignals = 10;
    this.cooldownMs = 5 * 60 * 1000;
    this.dailyLimit = 5;
    this.dailyTradeLimit = 3;

    // Per-direction cooldown tracking
    this.lastSignalTimeByDirection = {
      BUY_CE: 0,
      BUY_PE: 0,
    };

    // Deduplication set: Set<string> of composite keys
    this.dedupKeys = new Set();

    // Signal lifecycle tracking (in-memory, backed by DB)
    this.activeSignals = new Map(); // instrument -> { signalId, type, timestamp }

    this.reset();
  }

  reset() {
    this.signals.length = 0;
    this.dedupKeys.clear();
    this.activeSignals.clear();
    this.lastSignalTimeByDirection = { BUY_CE: 0, BUY_PE: 0 };
    this.dailySignalCount = 0;
    this.dailyTradeCount = 0;
    this.lastDay = new Date().getDate();
  }

  getSignals() {
    return [...this.signals];
  }

  getSignalCount() {
    return this.signals.length;
  }

  getActiveSignal(instrumentId) {
    return this.activeSignals.get(instrumentId) || null;
  }

  // ── DEDUPLICATION ────────────────────────────────────────────
  _buildDedupKey(instrumentId, type, atmStrike, timestamp) {
    const hour = new Date(timestamp).getHours();
    return `${instrumentId}:${type}:${atmStrike}:${hour}`;
  }

  _isDuplicate(instrumentId, type, atmStrike, timestamp) {
    const key = this._buildDedupKey(instrumentId, type, atmStrike, timestamp);
    return this.dedupKeys.has(key);
  }

  _markDedup(instrumentId, type, atmStrike, timestamp) {
    const key = this._buildDedupKey(instrumentId, type, atmStrike, timestamp);
    this.dedupKeys.add(key);
    // Auto-expire dedup keys after 2 hours (memory cleanup)
    setTimeout(() => this.dedupKeys.delete(key), 2 * 60 * 60 * 1000);
  }

  // ── BOUNDED ARRAY (Ring Buffer) ────────────────────────────
  _addSignal(signal) {
    if (this.signals.length >= this.maxSignals) {
      this.signals.shift(); // remove oldest
    }
    this.signals.push(signal);
  }

  // ── LIFECYCLE MANAGEMENT ───────────────────────────────────
  activateSignal(instrumentId, signalId) {
    this.activeSignals.set(instrumentId, { signalId, type: signalId.split('_')[1], timestamp: Date.now() });
  }

  closeSignal(instrumentId, signalId, outcome) {
    const active = this.activeSignals.get(instrumentId);
    if (active && active.signalId === signalId) {
      this.activeSignals.delete(instrumentId);
    }
    // Update signal in ring buffer
    const sig = this.signals.find(s => s.id === signalId);
    if (sig) {
      sig.outcome = outcome;
      sig.status = 'CLOSED';
    }
  }

  // ── EVALUATE (STRATEGY LOGIC UNCHANGED) ────────────────────
  evaluate(ctx) {
    const { instrument, timestamp, indicators, marketState, oiAnalysis, regime, candles, profile } = ctx;
    const today = new Date().getDate();
    if (today !== this.lastDay) {
      this.reset();
      this.lastDay = today;
    }

    // Hard filters
    if (this.dailySignalCount >= this.dailyLimit) return null;
    if (this.dailyTradeCount >= this.dailyTradeLimit) return null;

    const currentTime = new Date(timestamp);
    const hour = currentTime.getHours();
    const minute = currentTime.getMinutes();
    if (hour < 9 || (hour === 9 && minute < 15)) return null;
    if (hour >= 15 && minute >= 30) return null;

    const isOptimal = profile.optimalWindows.some(w => {
      const [startH, startM] = w.start.split(':').map(Number);
      const [endH, endM] = w.end.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      const currentMinutes = hour * 60 + minute;
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    });
    if (!isOptimal) return null;

    // Cooldown check — PER DIRECTION
    const ceCooldown = timestamp - this.lastSignalTimeByDirection.BUY_CE < this.cooldownMs;
    const peCooldown = timestamp - this.lastSignalTimeByDirection.BUY_PE < this.cooldownMs;

    const { ema5, ema9, ema21, vwap, bb, rsi, atr14, volume, avgVolume } = indicators;
    const { state: marketStateValue, confidence: marketStateConfidence, reasons: marketStateReasons } = marketState;
    const { pcr, pcrBias, oiBullish, oiBearish, imbalance, nearSupport, nearResistance, isPinned, wallPressure } = oiAnalysis;
    const { regime, regimeStrength } = regime;
    const { bodyRatio, upperWick, lowerWick } = candles.current5m || {};

    let score = 0;
    const factors = []; // For audit trail

    // EMA alignment
    if (ema5 > ema9 && ema9 > ema21) {
      score += 15;
      factors.push({ name: 'Bullish EMA', score: 15, weight: 0.15 });
    } else if (ema5 < ema9 && ema9 < ema21) {
      score -= 15;
      factors.push({ name: 'Bearish EMA', score: -15, weight: 0.15 });
    }

    // VWAP position
    if (candles.current5m && candles.current5m.close > vwap) {
      score += 10;
      factors.push({ name: 'Above VWAP', score: 10, weight: 0.10 });
    } else if (candles.current5m && candles.current5m.close < vwap) {
      score -= 10;
      factors.push({ name: 'Below VWAP', score: -10, weight: 0.10 });
    }

    // RSI zone
    if (rsi > 55 && rsi < 70) {
      score += 10;
      factors.push({ name: 'RSI Bullish Zone', score: 10, weight: 0.10 });
    } else if (rsi < 45 && rsi > 30) {
      score -= 10;
      factors.push({ name: 'RSI Bearish Zone', score: -10, weight: 0.10 });
    }
    // NOTE: RSI > 70 or < 30 scores 0 — no penalty. This is existing behavior.

    // Market state
    if (marketStateValue === 'TRENDING_BULLISH') {
      score += 15;
      factors.push({ name: 'Trending Bullish', score: 15, weight: 0.15 });
    } else if (marketStateValue === 'TRENDING_BEARISH') {
      score -= 15;
      factors.push({ name: 'Trending Bearish', score: -15, weight: 0.15 });
    } else if (marketStateValue === 'BREAKOUT') {
      if (marketStateConfidence > 70) {
        score += 20;
        factors.push({ name: 'High Confidence Breakout', score: 20, weight: 0.20 });
      } else {
        score += 10;
        factors.push({ name: 'Breakout', score: 10, weight: 0.10 });
      }
    } else if (marketStateValue === 'SIDEWAYS') {
      score -= 10;
      factors.push({ name: 'Sideways Market', score: -10, weight: 0.10 });
    } else if (marketStateValue === 'VOLATILE') {
      score -= 5;
      factors.push({ name: 'Volatile Market', score: -5, weight: 0.05 });
    }

    // OI confirmation
    if (pcrBias === 'BULLISH') {
      score += 15;
      factors.push({ name: 'OI Bullish Bias', score: 15, weight: 0.15 });
    } else if (pcrBias === 'SLIGHT_BULLISH') {
      score += 8;
      factors.push({ name: 'OI Slight Bullish', score: 8, weight: 0.08 });
    } else if (pcrBias === 'BEARISH') {
      score -= 15;
      factors.push({ name: 'OI Bearish Bias', score: -15, weight: 0.15 });
    } else if (pcrBias === 'SLIGHT_BEARISH') {
      score -= 8;
      factors.push({ name: 'OI Slight Bearish', score: -8, weight: 0.08 });
    }

    if (oiBullish) {
      score += 10;
      factors.push({ name: 'OI Bullish Buildup', score: 10, weight: 0.10 });
    }
    if (oiBearish) {
      score -= 10;
      factors.push({ name: 'OI Bearish Buildup', score: -10, weight: 0.10 });
    }

    // Imbalance
    if (imbalance > 0.15) {
      score += 8;
      factors.push({ name: 'Bullish Imbalance', score: 8, weight: 0.08 });
    } else if (imbalance < -0.15) {
      score -= 8;
      factors.push({ name: 'Bearish Imbalance', score: -8, weight: 0.08 });
    }

    // Wall pressure
    if (wallPressure === 'BULLISH') {
      score += 5;
      factors.push({ name: 'Bullish Wall Pressure', score: 5, weight: 0.05 });
    } else if (wallPressure === 'BEARISH') {
      score -= 5;
      factors.push({ name: 'Bearish Wall Pressure', score: -5, weight: 0.05 });
    }

    // Regime
    if (regime === 'TRENDING' && regimeStrength > 0.6) {
      if (score > 0) {
        score += 10;
        factors.push({ name: 'Trending Regime', score: 10, weight: 0.10 });
      } else if (score < 0) {
        score -= 10;
        factors.push({ name: 'Trending Regime', score: -10, weight: 0.10 });
      }
    }

    // ATR filter
    if (atr14 < candles.current5m.close * 0.001) {
      score -= 10;
      factors.push({ name: 'Low ATR', score: -10, weight: 0.10 });
    }

    // Volume filter
    if (volume < avgVolume * 0.5) {
      score -= 5;
      factors.push({ name: 'Low Volume', score: -5, weight: 0.05 });
    }

    // Candle confirmation
    if (candles.current5m && candles.current5m.body && candles.current5m.close) {
      if (bodyRatio > 0.6 && candles.current5m.close > candles.current5m.open && score > 0) {
        score += 5;
        factors.push({ name: 'Strong Bullish Candle', score: 5, weight: 0.05 });
      } else if (bodyRatio > 0.6 && candles.current5m.close < candles.current5m.open && score < 0) {
        score -= 5;
        factors.push({ name: 'Strong Bearish Candle', score: -5, weight: 0.05 });
      }
    }

    // Generate signal
    let signal = null;
    let signalType = null;
    let confidence = 0;
    let strength = 'WEAK';

    if (score >= 40) {
      signalType = 'BUY_CE';
      if (ceCooldown) {
        logger.info(`[SignalEngine] BUY_CE blocked by per-direction cooldown`);
        return null;
      }
    } else if (score <= -40) {
      signalType = 'BUY_PE';
      if (peCooldown) {
        logger.info(`[SignalEngine] BUY_PE blocked by per-direction cooldown`);
        return null;
      }
    }

    if (!signalType) return null;

    // Deduplication check
    const atmStrike = ctx.atmStrike || Math.round(ctx.indicators?.vwap / 50) * 50;
    if (this._isDuplicate(instrument, signalType, atmStrike, timestamp)) {
      logger.info(`[SignalEngine] Duplicate signal blocked: ${instrument} ${signalType} strike=${atmStrike}`);
      return null;
    }

    confidence = Math.min(95, Math.abs(score) + 50);
    if (confidence >= 85) strength = 'STRONG';
    else if (confidence >= 70) strength = 'MODERATE';
    else strength = 'WEAK';

    signal = {
      id: `SIG_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: signalType,
      score,
      confidence,
      strength,
      timestamp,
      instrument,
      atmStrike,
      marketState: marketStateValue,
      marketStateConfidence,
      oiBias: pcrBias,
      regime,
      regimeStrength,
      factors, // NEW: audit trail
      status: 'NEW', // NEW: lifecycle state
    };

    this._addSignal(signal);
    this._markDedup(instrument, signalType, atmStrike, timestamp);
    this.lastSignalTimeByDirection[signalType] = timestamp;
    this.dailySignalCount++;

    logger.info(`[SignalEngine] ${signalType} generated for ${instrument} | Score: ${score} | Confidence: ${confidence}% | Strength: ${strength} | Factors: ${factors.length}`);
    return signal;
  }
}

module.exports = { SignalEngine };
