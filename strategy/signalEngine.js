// ============================================================
// SIGNAL ENGINE — Institutional Grade A
// Weighted confluence scoring (0.0-1.0 scale)
// Dynamic target/SL via ATR × DNA multipliers
// ============================================================

const { STATES } = require('./marketStateEngine');

class SignalEngine {
  constructor() {
    this.todaySignals = [];
    this.lastSignal = null;
    this.lastDate = null;
    this.setupsInProgress = new Map();
    // Backward-compat defaults (overridden by DNA)
    this.maxPerDay = 5;
    this.cooldownMs = 5 * 60 * 1000;
  }

  _ensureDay() {
    const today = new Date().toDateString();
    if (this.lastDate !== today) {
      this.lastDate = today;
      this.resetDay();
    }
  }

  resetDay() {
    this.todaySignals = [];
    this.lastSignal = null;
    this.setupsInProgress.clear();
    console.log('📅 Signal engine reset for new day');
  }

  // ------------------------------------------------------------------
  // DNA FILTER HELPERS
  // ------------------------------------------------------------------

  _toISTMinutes(currentTime) {
    const d = new Date(currentTime || Date.now());
    const istStr = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    const [datePart, timePart] = istStr.split(', ');
    const [h, m] = timePart.split(':').map(Number);
    return h * 60 + m;
  }

  _isInOptimalWindow(currentTime, windows) {
    if (!Array.isArray(windows) || windows.length === 0) return true;
    const mins = this._toISTMinutes(currentTime);
    for (const w of windows) {
      const [start, end] = w.split('-');
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      if (mins >= startMins && mins <= endMins) return true;
    }
    return false;
  }

  _checkFirst15MinBan(currentTime, dna) {
    if (!dna.first15MinBan) return true;
    const mins = this._toISTMinutes(currentTime);
    return mins >= 570; // 09:30
  }

  _checkLunchBan(currentTime, dna) {
    if (!dna.lunchBanStart || !dna.lunchBanEnd) return true;
    const mins = this._toISTMinutes(currentTime);
    const [sh, sm] = dna.lunchBanStart.split(':').map(Number);
    const [eh, em] = dna.lunchBanEnd.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    return mins < startMins || mins > endMins;
  }

  _checkGammaRisk(contract, dna) {
    if (!dna.gammaRiskExpiryHours || !contract?.expiry) return true;
    const now = new Date();
    const expiry = this._parseExpiry(contract.expiry);
    if (!expiry) return true;
    const hoursToExpiry = (expiry - now) / (1000 * 60 * 60);
    return hoursToExpiry >= dna.gammaRiskExpiryHours;
  }

  _parseExpiry(expiryStr) {
    if (!expiryStr) return null;
    // Handle formats: "16MAY2026", "16-MAY-2026", "16 MAY 2026"
    const clean = String(expiryStr).replace(/[-\s]/g, '').toUpperCase();
    const match = clean.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
    if (!match) return null;
    const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const year = parseInt(match[3], 10);
    if (month === undefined) return null;
    // Assume expiry is at 15:30 IST
    const d = new Date(year, month, day, 15, 30);
    return d;
  }

  _checkPremiumRange(premium, dna) {
    if (!Number.isFinite(premium)) return false;
    if (dna.minPremium !== undefined && premium < dna.minPremium) return false;
    if (dna.maxPremium !== undefined && premium > dna.maxPremium) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // WEIGHTED SCORING (0.0 - 1.0)
  // ------------------------------------------------------------------

  _scoreEMATrend(indicators, type) {
    const { ema } = indicators;
    if (!ema) return 0;
    const { ema5, ema9, ema15 } = ema;
    if (!Number.isFinite(ema5) || !Number.isFinite(ema9)) return 0;

    if (type === 'BUY_CE') {
      if (ema5 > ema9 && ema9 > ema15) return 1.0;
      if (ema5 > ema9) return 0.5;
      return 0.0;
    } else {
      if (ema5 < ema9 && ema9 < ema15) return 1.0;
      if (ema5 < ema9) return 0.5;
      return 0.0;
    }
  }

  _scoreVWAPBias(indicators, type) {
    const price = indicators.price;
    const vwap = indicators.vwap?.vwap;
    const atr = indicators.atr14;
    if (!Number.isFinite(price) || !Number.isFinite(vwap)) return 0;

    const threshold = Number.isFinite(atr) ? atr * 0.3 : 0;

    if (type === 'BUY_CE') {
      if (price > vwap + threshold) return 1.0;
      if (price > vwap) return 0.5;
      return 0.0;
    } else {
      if (price < vwap - threshold) return 1.0;
      if (price < vwap) return 0.5;
      return 0.0;
    }
  }

  _scoreHTFAlignment(indicators, type) {
    const { ema } = indicators;
    if (!ema) return 0;
    const ema9_15m = ema.ema9_15m;
    const ema15_15m = ema.ema15_15m;
    if (!Number.isFinite(ema9_15m) || !Number.isFinite(ema15_15m)) return 0;

    const diff = Math.abs(ema9_15m - ema15_15m);
    const threshold = ema15_15m * 0.001; // 0.1% tolerance for "close"

    if (type === 'BUY_CE') {
      if (ema9_15m > ema15_15m) {
        return diff < threshold ? 0.5 : 1.0;
      }
      return 0.0;
    } else {
      if (ema9_15m < ema15_15m) {
        return diff < threshold ? 0.5 : 1.0;
      }
      return 0.0;
    }
  }

  _scoreOIWallBreak(indicators, oiAnalysis, type) {
    if (!oiAnalysis) return 0;
    const price = indicators.price;

    if (type === 'BUY_CE') {
      const res = oiAnalysis.walls?.resistanceNearest;
      const weakening = oiAnalysis.wallPressure?.resistanceWeakening;
      if (!res || !Number.isFinite(res.center)) return 0;
      if (price > res.center && weakening) return 1.0;
      if (oiAnalysis.proximity?.nearResistance && weakening) return 0.5;
      return 0.0;
    } else {
      const sup = oiAnalysis.walls?.supportNearest;
      const weakening = oiAnalysis.wallPressure?.supportWeakening;
      if (!sup || !Number.isFinite(sup.center)) return 0;
      if (price < sup.center && weakening) return 1.0;
      if (oiAnalysis.proximity?.nearSupport && weakening) return 0.5;
      return 0.0;
    }
  }

  _scoreVolumeSpike(indicators) {
    const vol = indicators.volume;
    if (!vol) return 0;
    const { current, avg20 } = vol;
    if (!Number.isFinite(current) || !Number.isFinite(avg20) || avg20 <= 0) return 0;
    const ratio = current / avg20;
    if (ratio > 1.5) return 1.0;
    if (ratio > 1.2) return 0.5;
    return 0.0;
  }

  _scoreCandlePattern(indicators, type) {
    const candle = indicators.candle?.last;
    if (!candle) return 0;

    // Against direction penalties
    if (type === 'BUY_CE') {
      if (candle.isDoji || candle.isShootingStar) return 0.0;
      if (candle.bullish && candle.bodyPct > 60) return 1.0;
      if (candle.bullish && candle.bodyPct > 20) return 0.5;
      return 0.0;
    } else {
      if (candle.isDoji || candle.isHammer) return 0.0;
      if (candle.bearish && candle.bodyPct > 60) return 1.0;
      if (candle.bearish && candle.bodyPct > 20) return 0.5;
      return 0.0;
    }
  }

  // ------------------------------------------------------------------
  // DIRECTIONAL EVALUATION
  // ------------------------------------------------------------------

  _evaluateDirection(indicators, marketState, oiAnalysis, type, dna, regime) {
    if (!indicators || !marketState) return null;

    // Only tradeable states
    if (!['TRENDING_BULLISH', 'TRENDING_BEARISH', 'BREAKOUT'].includes(marketState.state)) {
      return null;
    }

    // Staleness guardrails
    if (oiAnalysis?.stale || oiAnalysis?.premiumsStale) return null;

    // Direction-state alignment
    if (type === 'BUY_CE' && marketState.state === 'TRENDING_BEARISH') return null;
    if (type === 'BUY_PE' && marketState.state === 'TRENDING_BULLISH') return null;

    // OI pin zone
    if (oiAnalysis?.nearPin) {
      console.log(`🚫 ${type} blocked — OI pin zone`);
      return null;
    }

    // Weighted scoring
    const emaTrend = this._scoreEMATrend(indicators, type);
    const vwapBias = this._scoreVWAPBias(indicators, type);
    const htfAlign = this._scoreHTFAlignment(indicators, type);
    const oiWall = this._scoreOIWallBreak(indicators, oiAnalysis, type);
    const volSpike = this._scoreVolumeSpike(indicators);
    const candlePat = this._scoreCandlePattern(indicators, type);

    const weights = {
      emaTrend: 0.25,
      vwapBias: 0.20,
      htfAlignment: 0.20,
      oiWallBreak: 0.15,
      volumeSpike: 0.10,
      candlePattern: 0.10,
    };

    let finalScore =
      emaTrend * weights.emaTrend +
      vwapBias * weights.vwapBias +
      htfAlign * weights.htfAlignment +
      oiWall * weights.oiWallBreak +
      volSpike * weights.volumeSpike +
      candlePat * weights.candlePattern;

    // Regime penalty
    if (regime && regime.regime === 'ELEVATED') {
      finalScore = Math.max(0, finalScore - 0.15);
    }

    // Build factors for transparency
    const factors = [
      { name: 'EMA Trend', score: emaTrend, weight: weights.emaTrend, weighted: emaTrend * weights.emaTrend },
      { name: 'VWAP Bias', score: vwapBias, weight: weights.vwapBias, weighted: vwapBias * weights.vwapBias },
      { name: 'HTF Alignment', score: htfAlign, weight: weights.htfAlignment, weighted: htfAlign * weights.htfAlignment },
      { name: 'OI Wall Break', score: oiWall, weight: weights.oiWallBreak, weighted: oiWall * weights.oiWallBreak },
      { name: 'Volume Spike', score: volSpike, weight: weights.volumeSpike, weighted: volSpike * weights.volumeSpike },
      { name: 'Candle Pattern', score: candlePat, weight: weights.candlePattern, weighted: candlePat * weights.candlePattern },
    ];

    if (regime?.regime === 'ELEVATED') {
      factors.push({ name: 'ELEVATED Regime Penalty', score: -0.15, weight: 1, weighted: -0.15 });
    }

    return {
      type,
      finalScore: parseFloat(finalScore.toFixed(4)),
      factors,
      rawScores: { emaTrend, vwapBias, htfAlign, oiWall, volSpike, candlePat },
    };
  }

  // ------------------------------------------------------------------
  // SIGNAL BUILDER
  // ------------------------------------------------------------------

  _buildSignal(evalResult, indicators, entryPremium, contract, dna, regime, stage) {
    const now = Date.now();
    const atr = indicators.atr14 || 25;

    // Dynamic target/SL from DNA
    let targetPts = Math.round(atr * dna.atrMultiplier.target);
    let slPts = Math.round(atr * dna.atrMultiplier.sl);

    // HIGH regime: widen by 1.5x
    if (regime && regime.regime === 'HIGH') {
      targetPts = Math.round(targetPts * 1.5);
      slPts = Math.round(slPts * 1.5);
    }

    const signal = {
      id: `SIG_${now}`,
      type: evalResult.type,
      confidence: Math.round(evalResult.finalScore * 100),
      rawConfidence: Math.round(evalResult.finalScore * 100),
      finalScore: evalResult.finalScore,
      factors: evalResult.factors,
      rawScores: evalResult.rawScores,
      time: now,
      timeStr: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      price: indicators.price,
      vwap: indicators.vwap?.vwap,
      ema5: indicators.ema?.ema5,
      ema9: indicators.ema?.ema9,
      ema15: indicators.ema?.ema15,
      signalNum: this.todaySignals.length + 1,
      entryPremium: entryPremium,
      strike: contract?.strike ?? null,
      optionToken: contract?.token ?? null,
      expiry: contract?.expiry ?? null,
      target: entryPremium ? parseFloat((entryPremium + targetPts).toFixed(2)) : null,
      sl: entryPremium ? parseFloat((entryPremium - slPts).toFixed(2)) : null,
      targetPts,
      slPts,
      atr: indicators.atr14,
      tradeStatus: entryPremium ? 'OPEN' : 'NO_TRADE',
      signalStage: stage,
      regime: regime?.regime || null,
      dna: dna.name || 'UNKNOWN',
    };

    return signal;
  }

  // ------------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------------

  /**
   * Evaluate market conditions and emit signal if criteria met
   * New signature includes dna and regime for institutional grading
   */
  evaluate(indicators, marketState, oiAnalysis, currentTime, premiums, meta, dna, regime) {
    if (!indicators || !marketState) return null;

    this._ensureDay();

    // Use DNA limits with backward-compat fallbacks
    const maxSignals = dna?.maxSignalsDay ?? this.maxPerDay;
    const cooldown = dna?.cooldownMs ?? this.cooldownMs;

    if (this.todaySignals.length >= maxSignals) return null;
    if (this.lastSignal && Date.now() - this.lastSignal.time < cooldown) return null;

    // ---- DNA FILTERS (strict order) ----

    // a. Regime filter
    if (regime && (regime.regime === 'EXTREME' || regime.regime === 'DEAD')) {
      return null;
    }

    // b. Optimal windows
    if (dna?.optimalWindows && !this._isInOptimalWindow(currentTime, dna.optimalWindows)) {
      return null;
    }

    // c. First 15 min ban
    if (!this._checkFirst15MinBan(currentTime, dna)) {
      return null;
    }

    // d. Lunch ban
    if (!this._checkLunchBan(currentTime, dna)) {
      return null;
    }

    // Evaluate both directions
    const ceEval = this._evaluateDirection(indicators, marketState, oiAnalysis, 'BUY_CE', dna, regime);
    const peEval = this._evaluateDirection(indicators, marketState, oiAnalysis, 'BUY_PE', dna, regime);

    const candidates = [ceEval, peEval].filter(Boolean).sort((a, b) => b.finalScore - a.finalScore);
    if (candidates.length === 0) return null;

    const winner = candidates[0];
    const isCE = winner.type === 'BUY_CE';
    const entryPremium = isCE ? premiums?.ce : premiums?.pe;
    const contract = meta?.exec ? (isCE ? meta.exec.ce : meta.exec.pe) : null;

    // e. Gamma risk filter
    if (!this._checkGammaRisk(contract, dna)) {
      return null;
    }

    // f. Premium range filter
    if (!this._checkPremiumRange(entryPremium, dna)) {
      return null;
    }

    // Determine stage
    let stage = 'NONE';
    if (winner.finalScore >= 0.72) stage = 'CONFIRMED';
    else if (winner.finalScore >= 0.55) stage = 'SETUP';

    if (stage === 'NONE') return null;

    const signal = this._buildSignal(winner, indicators, entryPremium, contract, dna, regime, stage);

    if (stage === 'CONFIRMED') {
      this.todaySignals.push(signal);
      this.lastSignal = signal;
      console.log(
        `🚨 SIGNAL #${signal.signalNum}: ${signal.type} Score: ${signal.finalScore} Confidence: ${signal.confidence}% Price: ${signal.price} Premium: ${entryPremium ?? 'N/A'} Strike: ${signal.strike ?? 'N/A'} Target: ${signal.targetPts} SL: ${signal.slPts}`
      );
    } else if (stage === 'SETUP') {
      this.setupsInProgress.set(signal.id, { signal, timestamp: Date.now() });
      console.log(
        `⏳ SETUP #${this.setupsInProgress.size}: ${signal.type} Score: ${signal.finalScore} Confidence: ${signal.confidence}% Price: ${signal.price}`
      );
    }

    return signal;
  }

  /**
   * Promote a setup to confirmed (called by orchestrator when abortEngine confirms)
   */
  confirmSetup(signal) {
    this._ensureDay();
    const maxSignals = signal.dna?.maxSignalsDay ?? this.maxPerDay;
    if (this.todaySignals.length >= maxSignals) return null;

    signal.signalStage = 'CONFIRMED';
    signal.time = Date.now();
    signal.timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    signal.signalNum = this.todaySignals.length + 1;

    this.todaySignals.push(signal);
    this.lastSignal = signal;

    console.log(
      `🚨 SIGNAL #${signal.signalNum}: ${signal.type} [ESCALATED] Score: ${signal.finalScore} Confidence: ${signal.confidence}%`
    );

    return signal;
  }

  /**
   * Legacy preview method (backward compatible)
   */
  preview(indicators, marketState, oiAnalysis, currentTime, premiums, meta = null) {
    this._ensureDay();
    const dna = meta?.dna || { maxSignalsDay: this.maxPerDay, optimalWindows: null, first15MinBan: false, lunchBanStart: null, lunchBanEnd: null, gammaRiskExpiryHours: null, minPremium: 0, maxPremium: 99999, atrMultiplier: { target: 0.8, sl: 0.6 } };
    const regime = meta?.regime || { regime: 'NORMAL' };

    if (this.todaySignals.length >= (dna.maxSignalsDay ?? this.maxPerDay)) return null;
    if (!this._isEntryTime(currentTime)) return null;

    // Use new evaluate with mock DNA
    const signal = this.evaluate(indicators, marketState, oiAnalysis, currentTime, premiums, meta, dna, regime);
    if (!signal) return null;

    // Return as candidate without committing
    return {
      ...signal,
      id: `CAND_${signal.type}_${Math.floor(Date.now() / 10000)}`,
      signalStage: 'CANDIDATE',
      tradeStatus: 'PENDING_CONFIRMATION',
    };
  }

  _isEntryTime() {
    const mins = this._toISTMinutes();
    if (mins < 570) return false; // before 9:30am
    if (mins > 930) return false; // after 3:30pm
    if (mins >= 720 && mins < 810) return false; // lunch 12:00–1:30
    return true;
  }

  updateSignalOutcome(signalId, outcome, pnl) {
    const sig = this.todaySignals.find(s => s.id === signalId);
    if (sig) {
      sig.tradeStatus = outcome;
      sig.pnl = pnl;
    }
  }

  getStats() {
    return {
      totalToday: this.todaySignals.length,
      remaining: (this.todaySignals[0]?.dna?.maxSignalsDay ?? this.maxPerDay) - this.todaySignals.length,
      lastSignal: this.lastSignal,
      signals: this.todaySignals,
      activeSetups: this.setupsInProgress.size,
    };
  }
}

module.exports = new SignalEngine();
