// ============================================================
// MULTI-INSTRUMENT MANAGER — Parallel Signal Generation
// Phase 2: Run SENSEX + NIFTY + BANKNIFTY + FINNIFTY + BANKEX simultaneously
// Each instrument gets fully isolated: candles, indicators, signals, trades, OI
// ============================================================

const { getIndicators, VWAPCalculator, calcATR } = require('./indicators');
const RegimeDetector = require('./regimeDetector');
const AbortEngine = require('./abortEngine');
const dnaProfiles = require('./dna/instrumentProfiles');

// ── INSTRUMENT CONFIG (mirror of server.js) ───────────────────
const INSTRUMENT_CONFIG = {
  SENSEX:    { name:'SENSEX',    displayName:'Sensex',     exchange:'BSE', optExchange:'BFO', indexToken:'99919000', wsExchangeType:3, step:100 },
  NIFTY:     { name:'NIFTY',     displayName:'Nifty',      exchange:'NSE', optExchange:'NFO', indexToken:'99926000', wsExchangeType:1, step:50  },
  BANKNIFTY: { name:'BANKNIFTY', displayName:'Bank Nifty', exchange:'NSE', optExchange:'NFO', indexToken:'99926009', wsExchangeType:1, step:100 },
  FINNIFTY:  { name:'FINNIFTY',  displayName:'Fin Nifty',  exchange:'NSE', optExchange:'NFO', indexToken:'99926037', wsExchangeType:1, step:50  },
  BANKEX:    { name:'BANKEX',    displayName:'Bankex',     exchange:'BSE', optExchange:'BFO', indexToken:'99919012', wsExchangeType:3, step:100 },
};

// ── INLINE CANDLE BUILDER (per-instance) ──────────────────────
class CandleBuilderInstance {
  constructor() {
    this.candles = { 5: [], 15: [], 30: [] };
    this.current = { 5: null, 15: null, 30: null };
    this.lastSlot = { 5: null, 15: null, 30: null };
  }

  tick(price, ts) {
    const intervals = [5, 15, 30];
    for (const interval of intervals) {
      const slot = Math.floor(ts / (interval * 60 * 1000));
      if (slot !== this.lastSlot[interval]) {
        if (this.current[interval]) {
          this.candles[interval].push({ ...this.current[interval] });
          if (this.candles[interval].length > 500) this.candles[interval].shift();
        }
        this.current[interval] = { time: slot, open: price, high: price, low: price, close: price, ticks: 1, volume: 1 };
        this.lastSlot[interval] = slot;
      } else if (this.current[interval]) {
        this.current[interval].high = Math.max(this.current[interval].high, price);
        this.current[interval].low = Math.min(this.current[interval].low, price);
        this.current[interval].close = price;
        this.current[interval].ticks++;
        this.current[interval].volume++;
      }
    }
  }

  getAllCandles(interval, max = 200) {
    const arr = [...this.candles[interval]];
    if (this.current[interval]) arr.push(this.current[interval]);
    return arr.slice(-max);
  }

  getCurrent(interval) { return this.current[interval]; }

  preload(data, interval) {
    this.candles[interval] = data.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, ticks: c.volume || 1, volume: c.volume || 1
    }));
  }

  reset() {
    this.candles = { 5: [], 15: [], 30: [] };
    this.current = { 5: null, 15: null, 30: null };
    this.lastSlot = { 5: null, 15: null, 30: null };
  }
}

// ── INLINE OI ENGINE (simplified per-instance) ───────────────
class OIEngineInstance {
  constructor() {
    this.snapshot = null;
    this.chainHistory = [];
  }

  update(chainData) {
    if (!Array.isArray(chainData)) return null;
    this.snapshot = chainData;
    this.chainHistory.push(chainData);
    if (this.chainHistory.length > 10) this.chainHistory.shift();
    return this.snapshot;
  }

  getAnalysis(spot) {
    if (!this.snapshot || !this.snapshot.length) return null;
    const px = Number(spot);
    if (!Number.isFinite(px)) return null;

    const rows = this.snapshot;
    const totalCEoi = rows.reduce((s, r) => s + (Number(r.CE?.oi) || 0), 0);
    const totalPEoi = rows.reduce((s, r) => s + (Number(r.PE?.oi) || 0), 0);
    const totalOI = totalCEoi + totalPEoi;
    const pcr = totalPEoi > 0 ? totalCEoi / totalPEoi : 1;

    // Find nearest walls
    const ceRows = rows.filter(r => r.CE?.oi > 0).sort((a, b) => (b.CE.oi) - (a.CE.oi)).slice(0, 5);
    const peRows = rows.filter(r => r.PE?.oi > 0).sort((a, b) => (b.PE.oi) - (a.PE.oi)).slice(0, 5);

    const resistanceNearest = ceRows[0] ? { center: ceRows[0].strikePrice, strength: ceRows[0].CE.oi } : null;
    const supportNearest = peRows[0] ? { center: peRows[0].strikePrice, strength: peRows[0].PE.oi } : null;

    const nearResistance = resistanceNearest && Math.abs(px - resistanceNearest.center) < 200;
    const nearSupport = supportNearest && Math.abs(px - supportNearest.center) < 200;

    return {
      totalCEoi, totalPEoi, pcr,
      walls: { resistanceNearest, supportNearest },
      wallPressure: { resistanceWeakening: false, supportWeakening: false },
      proximity: { nearResistance, nearSupport },
      ceBuyConfirmed: pcr < 1,
      peBuyConfirmed: pcr > 1,
      nearPin: false,
      stale: false,
      premiumsStale: false,
    };
  }

  reset() { this.snapshot = null; this.chainHistory = []; }
}

// ── INLINE SIGNAL ENGINE (per-instance, Grade A logic) ───────
class SignalEngineInstance {
  constructor(dna) {
    this.dna = dna;
    this.todaySignals = [];
    this.lastSignal = null;
    this.lastDate = null;
    this.setupsInProgress = new Map();
    this.maxPerDay = dna.maxSignalsDay || 5;
    this.cooldownMs = dna.cooldownMs || 300000;
  }

  _ensureDay() {
    const today = new Date().toDateString();
    if (this.lastDate !== today) { this.lastDate = today; this.resetDay(); }
  }

  resetDay() {
    this.todaySignals = [];
    this.lastSignal = null;
    this.setupsInProgress.clear();
  }

  _toISTMinutes(currentTime) {
    const d = new Date(currentTime || Date.now());
    const istStr = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    const timePart = istStr.split(', ')[1];
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
      if (mins >= sh * 60 + sm && mins <= eh * 60 + em) return true;
    }
    return false;
  }

  _checkFirst15MinBan(currentTime) {
    if (!this.dna.first15MinBan) return true;
    return this._toISTMinutes(currentTime) >= 570;
  }

  _checkLunchBan(currentTime) {
    if (!this.dna.lunchBanStart || !this.dna.lunchBanEnd) return true;
    const mins = this._toISTMinutes(currentTime);
    const [sh, sm] = this.dna.lunchBanStart.split(':').map(Number);
    const [eh, em] = this.dna.lunchBanEnd.split(':').map(Number);
    return mins < sh * 60 + sm || mins > eh * 60 + em;
  }

  _checkGammaRisk(contract) {
    if (!this.dna.gammaRiskExpiryHours || !contract?.expiry) return true;
    const now = new Date();
    const expiry = this._parseExpiry(contract.expiry);
    if (!expiry) return true;
    return (expiry - now) / (1000 * 60 * 60) >= this.dna.gammaRiskExpiryHours;
  }

  _parseExpiry(expiryStr) {
    if (!expiryStr) return null;
    const clean = String(expiryStr).replace(/[-\s]/g, '').toUpperCase();
    const match = clean.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
    if (!match) return null;
    const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const year = parseInt(match[3], 10);
    if (month === undefined) return null;
    return new Date(year, month, day, 15, 30);
  }

  _checkPremiumRange(premium) {
    if (!Number.isFinite(premium)) return false;
    if (this.dna.minPremium !== undefined && premium < this.dna.minPremium) return false;
    if (this.dna.maxPremium !== undefined && premium > this.dna.maxPremium) return false;
    return true;
  }

  _scoreEMATrend(indicators, type) {
    const { ema } = indicators;
    if (!ema || !Number.isFinite(ema.ema5) || !Number.isFinite(ema.ema9)) return 0;
    if (type === 'BUY_CE') {
      if (ema.ema5 > ema.ema9 && ema.ema9 > ema.ema15) return 1.0;
      if (ema.ema5 > ema.ema9) return 0.5;
      return 0.0;
    } else {
      if (ema.ema5 < ema.ema9 && ema.ema9 < ema.ema15) return 1.0;
      if (ema.ema5 < ema.ema9) return 0.5;
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
    if (!ema || !Number.isFinite(ema.ema9_15m) || !Number.isFinite(ema.ema15_15m)) return 0;
    const diff = Math.abs(ema.ema9_15m - ema.ema15_15m);
    const threshold = ema.ema15_15m * 0.001;
    if (type === 'BUY_CE') {
      if (ema.ema9_15m > ema.ema15_15m) return diff < threshold ? 0.5 : 1.0;
      return 0.0;
    } else {
      if (ema.ema9_15m < ema.ema15_15m) return diff < threshold ? 0.5 : 1.0;
      return 0.0;
    }
  }

  _scoreOIWallBreak(indicators, oiAnalysis, type) {
    if (!oiAnalysis) return 0;
    const price = indicators.price;
    if (type === 'BUY_CE') {
      const res = oiAnalysis.walls?.resistanceNearest;
      if (!res || !Number.isFinite(res.center)) return 0;
      if (price > res.center) return 1.0;
      if (oiAnalysis.proximity?.nearResistance) return 0.5;
      return 0.0;
    } else {
      const sup = oiAnalysis.walls?.supportNearest;
      if (!sup || !Number.isFinite(sup.center)) return 0;
      if (price < sup.center) return 1.0;
      if (oiAnalysis.proximity?.nearSupport) return 0.5;
      return 0.0;
    }
  }

  _scoreVolumeSpike(indicators) {
    const vol = indicators.volume;
    if (!vol || !Number.isFinite(vol.current) || !Number.isFinite(vol.avg20) || vol.avg20 <= 0) return 0;
    const ratio = vol.current / vol.avg20;
    if (ratio > 1.5) return 1.0;
    if (ratio > 1.2) return 0.5;
    return 0.0;
  }

  _scoreCandlePattern(indicators, type) {
    const candle = indicators.candle?.last;
    if (!candle) return 0;
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

  evaluate(indicators, marketState, oiAnalysis, currentTime, premiums, meta, regime) {
    if (!indicators || !marketState) return null;
    this._ensureDay();
    if (this.todaySignals.length >= this.maxPerDay) return null;
    if (this.lastSignal && Date.now() - this.lastSignal.time < this.cooldownMs) return null;

    if (regime && (regime.regime === 'EXTREME' || regime.regime === 'DEAD')) return null;
    if (this.dna.optimalWindows && !this._isInOptimalWindow(currentTime, this.dna.optimalWindows)) return null;
    if (!this._checkFirst15MinBan(currentTime)) return null;
    if (!this._checkLunchBan(currentTime)) return null;

    const ceEval = this._evaluateDirection(indicators, marketState, oiAnalysis, 'BUY_CE', regime);
    const peEval = this._evaluateDirection(indicators, marketState, oiAnalysis, 'BUY_PE', regime);
    const candidates = [ceEval, peEval].filter(Boolean).sort((a, b) => b.finalScore - a.finalScore);
    if (candidates.length === 0) return null;

    const winner = candidates[0];
    const isCE = winner.type === 'BUY_CE';
    const entryPremium = isCE ? premiums?.ce : premiums?.pe;
    const contract = meta?.exec ? (isCE ? meta.exec.ce : meta.exec.pe) : null;

    if (!this._checkGammaRisk(contract)) return null;
    if (!this._checkPremiumRange(entryPremium)) return null;

    let stage = 'NONE';
    if (winner.finalScore >= 0.72) stage = 'CONFIRMED';
    else if (winner.finalScore >= 0.55) stage = 'SETUP';
    if (stage === 'NONE') return null;

    const signal = this._buildSignal(winner, indicators, entryPremium, contract, regime, stage);

    if (stage === 'CONFIRMED') {
      this.todaySignals.push(signal);
      this.lastSignal = signal;
    } else if (stage === 'SETUP') {
      this.setupsInProgress.set(signal.id, { signal, timestamp: Date.now() });
    }
    return signal;
  }

  _evaluateDirection(indicators, marketState, oiAnalysis, type, regime) {
    if (!['TRENDING_BULLISH', 'TRENDING_BEARISH', 'BREAKOUT'].includes(marketState.state)) return null;
    if (oiAnalysis?.stale || oiAnalysis?.premiumsStale) return null;
    if (type === 'BUY_CE' && marketState.state === 'TRENDING_BEARISH') return null;
    if (type === 'BUY_PE' && marketState.state === 'TRENDING_BULLISH') return null;
    if (oiAnalysis?.nearPin) return null;

    const emaTrend = this._scoreEMATrend(indicators, type);
    const vwapBias = this._scoreVWAPBias(indicators, type);
    const htfAlign = this._scoreHTFAlignment(indicators, type);
    const oiWall = this._scoreOIWallBreak(indicators, oiAnalysis, type);
    const volSpike = this._scoreVolumeSpike(indicators);
    const candlePat = this._scoreCandlePattern(indicators, type);

    let finalScore =
      emaTrend * 0.25 + vwapBias * 0.20 + htfAlign * 0.20 +
      oiWall * 0.15 + volSpike * 0.10 + candlePat * 0.10;

    if (regime?.regime === 'ELEVATED') finalScore = Math.max(0, finalScore - 0.15);

    const factors = [
      { name: 'EMA Trend', score: emaTrend, weight: 0.25, weighted: emaTrend * 0.25 },
      { name: 'VWAP Bias', score: vwapBias, weight: 0.20, weighted: vwapBias * 0.20 },
      { name: 'HTF Alignment', score: htfAlign, weight: 0.20, weighted: htfAlign * 0.20 },
      { name: 'OI Wall Break', score: oiWall, weight: 0.15, weighted: oiWall * 0.15 },
      { name: 'Volume Spike', score: volSpike, weight: 0.10, weighted: volSpike * 0.10 },
      { name: 'Candle Pattern', score: candlePat, weight: 0.10, weighted: candlePat * 0.10 },
    ];
    if (regime?.regime === 'ELEVATED') factors.push({ name: 'ELEVATED Regime Penalty', score: -0.15, weight: 1, weighted: -0.15 });

    return { type, finalScore: parseFloat(finalScore.toFixed(4)), factors, rawScores: { emaTrend, vwapBias, htfAlign, oiWall, volSpike, candlePat } };
  }

  _buildSignal(evalResult, indicators, entryPremium, contract, regime, stage) {
    const now = Date.now();
    const atr = indicators.atr14 || 25;
    let targetPts = Math.round(atr * this.dna.atrMultiplier.target);
    let slPts = Math.round(atr * this.dna.atrMultiplier.sl);
    if (regime?.regime === 'HIGH') { targetPts = Math.round(targetPts * 1.5); slPts = Math.round(slPts * 1.5); }

    return {
      id: `SIG_${this.dna.name}_${now}`,
      type: evalResult.type,
      instrument: this.dna.name,
      displayText: `${evalResult.type === 'BUY_CE' ? 'Buy' : 'Sell'} ${this.dna.name} ${evalResult.type === 'BUY_CE' ? 'Call' : 'Put'}`,
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
      targetPts, slPts,
      atr: indicators.atr14,
      tradeStatus: entryPremium ? 'OPEN' : 'NO_TRADE',
      signalStage: stage,
      regime: regime?.regime || null,
      dna: this.dna.name || 'UNKNOWN',
    };
  }

  confirmSetup(signal) {
    this._ensureDay();
    if (this.todaySignals.length >= this.maxPerDay) return null;
    signal.signalStage = 'CONFIRMED';
    signal.time = Date.now();
    signal.timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    signal.signalNum = this.todaySignals.length + 1;
    this.todaySignals.push(signal);
    this.lastSignal = signal;
    return signal;
  }

  getStats() {
    return {
      totalToday: this.todaySignals.length,
      remaining: this.maxPerDay - this.todaySignals.length,
      lastSignal: this.lastSignal,
      signals: this.todaySignals,
      activeSetups: this.setupsInProgress.size,
    };
  }
}

// ── INLINE TRADE MANAGER (per-instance) ─────────────────────
class TradeManagerInstance {
  constructor(dna) {
    this.dna = dna;
    this.activeTrade = null;
    this.confirmedToday = 0;
    this.maxConfirmed = dna.maxTradesDay || 3;
    this.closedTrades = [];
    this.dailyPnL = 0;
  }

  canOpenNewTrade() {
    if (this.activeTrade) return { allowed: false, reason: 'Active trade exists' };
    if (this.confirmedToday >= this.maxConfirmed) return { allowed: false, reason: 'Daily limit reached' };
    return { allowed: true };
  }

  openTrade(signal, premium, contract) {
    const check = this.canOpenNewTrade();
    if (!check.allowed || !Number.isFinite(premium)) return null;
    const lotSize = this.dna?.lotSize || 20;
    const targetPts = signal.targetPts || 25;
    const slPts = signal.slPts || 20;

    this.activeTrade = {
      id: `TRADE_${this.dna.name}_${Date.now()}`,
      signalId: signal.id,
      instrument: this.dna.name,
      type: signal.type,
      entryPrice: signal.price ?? null,
      entryPremium: premium,
      currentPremium: premium,
      entryTime: Date.now(),
      strike: contract?.strike ?? signal.strike ?? null,
      optionToken: contract?.token ?? signal.optionToken ?? null,
      expiry: contract?.expiry ?? signal.expiry ?? null,
      target: parseFloat((premium + targetPts).toFixed(2)),
      sl: parseFloat((premium - slPts).toFixed(2)),
      trailSL: parseFloat((premium - slPts).toFixed(2)),
      trailing: false,
      maxProfit: 0,
      lots: this.dna.maxTradesDay || 15,
      lotSize,
      targetPts, slPts,
      status: 'OPEN'
    };
    this.confirmedToday++;
    return this.activeTrade;
  }

  update(currentPremium) {
    if (!this.activeTrade || this.activeTrade.status !== 'OPEN') return null;
    const trade = this.activeTrade;
    trade.currentPremium = currentPremium;
    const profit = currentPremium - trade.entryPremium;
    trade.maxProfit = Math.max(trade.maxProfit, profit);
    trade.unrealisedPnL = parseFloat((profit * trade.lotSize * trade.lots).toFixed(2));

    const trailTrigger = trade.targetPts * 0.6;
    if (profit >= trailTrigger && !trade.trailing) {
      trade.trailing = true;
      trade.trailSL = trade.entryPremium;
    }
    if (trade.trailing) {
      const trailAmount = trade.targetPts * 0.4;
      const newTrailSL = currentPremium - trailAmount;
      if (newTrailSL > trade.trailSL) trade.trailSL = parseFloat(newTrailSL.toFixed(2));
    }

    const effectiveSL = trade.trailing ? trade.trailSL : trade.sl;
    if (currentPremium <= effectiveSL) return this._closeTrade('SL_HIT', currentPremium);
    if (currentPremium >= trade.target) return this._closeTrade('TARGET_HIT', currentPremium);
    return null;
  }

  _closeTrade(reason, exitPremium) {
    const trade = this.activeTrade;
    const profit = exitPremium - trade.entryPremium;
    const pnl = parseFloat((profit * trade.lotSize * trade.lots).toFixed(2));
    const closed = { ...trade, exitPremium, exitTime: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }), reason, profit: parseFloat(profit.toFixed(2)), pnl, status: pnl >= 0 ? 'WIN' : 'LOSS' };
    this.closedTrades.push(closed);
    this.dailyPnL += pnl;
    this.activeTrade = null;
    return closed;
  }

  resetDay() { this.activeTrade = null; this.closedTrades = []; this.dailyPnL = 0; this.confirmedToday = 0; }
  getState() { return { activeTrade: this.activeTrade, closedTrades: this.closedTrades, dailyPnL: parseFloat(this.dailyPnL.toFixed(2)), totalTrades: this.closedTrades.length, wins: this.closedTrades.filter(t => t.status === 'WIN').length, losses: this.closedTrades.filter(t => t.status === 'LOSS').length }; }
}

// ── INLINE MARKET STATE ENGINE (per-instance) ────────────────
class MarketStateEngineInstance {
  constructor() { this.state = 'UNKNOWN'; this.history = []; this.priceHistory = []; }
  classify(indicators, oiAnalysis, regime = null) {
    if (!indicators) return { state: 'UNKNOWN', reasons: [], bullScore: 0, bearScore: 0 };
    const { bias, bb, momentum, candle, breakout, price } = indicators;
    const reasons = [];
    let bullScore = 0, bearScore = 0;
    this.priceHistory.push(price);
    if (this.priceHistory.length > 20) this.priceHistory.shift();

    if (bias.bullishEMA) { bullScore += 2; reasons.push('EMA_BULL_ALIGNED'); }
    if (bias.bearishEMA) { bearScore += 2; reasons.push('EMA_BEAR_ALIGNED'); }
    if (bias.aboveVWAP) { bullScore += 1; reasons.push('ABOVE_VWAP'); }
    if (bias.belowVWAP) { bearScore += 1; reasons.push('BELOW_VWAP'); }
    if (bias.htfBullish) { bullScore += 2; reasons.push('HTF_BULL'); }
    if (bias.htfBearish) { bearScore += 2; reasons.push('HTF_BEAR'); }
    if (momentum.bullMomentum) { bullScore += 1; reasons.push('BULL_MOMENTUM'); }
    if (momentum.bearMomentum) { bearScore += 1; reasons.push('BEAR_MOMENTUM'); }
    if (candle.last?.isStrong && candle.last?.bullish) { bullScore += 1; reasons.push('STRONG_BULL_CANDLE'); }
    if (candle.last?.isStrong && candle.last?.bearish) { bearScore += 1; reasons.push('STRONG_BEAR_CANDLE'); }
    if (breakout.priceAboveBB && bias.bullishEMA && momentum.bullMomentum) { reasons.push('BULL_BREAKOUT'); return { state: 'BREAKOUT', regime: regime?.regime || null, bullScore, bearScore, reasons, isSqueeze: false, isExpanding: true, isVolatile: false, isRanging: false, timestamp: Date.now() }; }
    if (breakout.priceBelowBB && bias.bearishEMA && momentum.bearMomentum) { reasons.push('BEAR_BREAKOUT'); return { state: 'BREAKOUT', regime: regime?.regime || null, bullScore, bearScore, reasons, isSqueeze: false, isExpanding: true, isVolatile: false, isRanging: false, timestamp: Date.now() }; }
    if (bullScore > bearScore + 2) { this.state = 'TRENDING_BULLISH'; }
    else if (bearScore > bullScore + 2) { this.state = 'TRENDING_BEARISH'; }
    else { this.state = 'SIDEWAYS'; }
    return { state: this.state, regime: regime?.regime || null, bullScore, bearScore, reasons, timestamp: Date.now() };
  }
  isTradeable() { return ['TRENDING_BULLISH', 'TRENDING_BEARISH', 'BREAKOUT'].includes(this.state); }
  reset() { this.state = 'UNKNOWN'; this.history = []; this.priceHistory = []; }
}

// ── INSTRUMENT ORCHESTRATOR (per-instance, self-contained) ───
class InstrumentOrchestrator {
  constructor(instrumentName) {
    this.name = instrumentName;
    this.dna = dnaProfiles[instrumentName] || dnaProfiles.SENSEX;
    this.instConfig = INSTRUMENT_CONFIG[instrumentName] || INSTRUMENT_CONFIG.SENSEX;
    this.candleBuilder = new CandleBuilderInstance();
    this.vwap = new VWAPCalculator();
    this.oiEngine = new OIEngineInstance();
    this.signalEngine = new SignalEngineInstance(this.dna);
    this.tradeManager = new TradeManagerInstance(this.dna);
    this.marketStateEngine = new MarketStateEngineInstance();
    this.regimeDetector = new RegimeDetector();
    this.abortEngine = new AbortEngine();
    this.lastIndicators = null;
    this.lastState = null;
    this.lastOI = null;
    this.lastRegime = null;
    this.lastATR = null;
    this.lastPrice = null;
    this.onSignal = null;
    this.onTradeOpen = null;
    this.onTradeClose = null;
    this.onUpdate = null;
    this.onSetupAbort = null;
    this._last5mSlot = null;
    this._lastAnalysisAt = 0;
    this._lastOptPremium = null;
    this._lastOptPremiumTs = 0;
    this._exec = { ce: null, pe: null };
    this._atm = null;
    this._lastResetDate = null;
  }

  onTick(ltp, timestamp = Date.now()) {
    if (typeof ltp !== 'number') return;
    this._checkDayReset();
    this.lastPrice = ltp;
    this.candleBuilder.tick(ltp, timestamp);
    const cur5m = this.candleBuilder.getCurrent(5);
    if (cur5m) this.vwap.update(cur5m);
    this._updateActiveTrade(ltp);

    const c5m = this.candleBuilder.getAllCandles(5, 200);
    if (c5m.length >= 20) {
      this.lastATR = RegimeDetector.calcATR(c5m, 14);
      const atrMA20 = this._calcATRMA20(c5m);
      this.lastRegime = RegimeDetector.classifyRegime(this.lastATR, atrMA20);
    }

    if (this.lastIndicators) {
      const abort = this.abortEngine.checkAbort(ltp, timestamp);
      if (abort) this.onSetupAbort?.(abort);
      const confirm = this.abortEngine.checkConfirm(ltp, this.lastIndicators.vwap?.vwap || ltp, this.lastIndicators.volume?.current || 0, this.lastIndicators.volume?.avg20 || 1, timestamp);
      if (confirm?.action === 'CONFIRM') this._handleSetupConfirm(confirm, timestamp);
    }

    const rolled = this._didFiveMinuteCandleRoll(cur5m?.time);
    if (rolled || Date.now() - this._lastAnalysisAt >= 10000) this._runAnalysis({ ltp, rolled });
  }

  _calcATRMA20(candles) {
    if (!candles || candles.length < 20) return null;
    const atrs = [];
    for (let i = 14; i < candles.length; i++) {
      const slice = candles.slice(Math.max(0, i - 14), i + 1);
      const atr = RegimeDetector.calcATR(slice, 14);
      if (atr !== null) atrs.push(atr);
    }
    if (atrs.length < 20) return null;
    return parseFloat((atrs.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2));
  }

  _handleSetupConfirm(confirm, timestamp) {
    const confirmed = this.signalEngine.confirmSetup(confirm.signal);
    if (!confirmed) return;
    const premium = confirmed.type === 'BUY_CE' ? this._exec.ce?.premium : this._exec.pe?.premium;
    const contract = confirmed.type === 'BUY_CE' ? this._exec.ce : this._exec.pe;
    if (Number.isFinite(premium)) {
      const trade = this.tradeManager.openTrade(confirmed, premium, contract);
      if (trade) this.onTradeOpen?.(trade);
    }
    confirmed.serverTime = timestamp;
    this.onSignal?.(confirmed);
  }

  onOptionLTP(premium, timestamp = Date.now()) {
    if (typeof premium !== 'number') return;
    this._lastOptPremium = premium;
    this._lastOptPremiumTs = timestamp;
  }

  onOptionChain(chainData, premiums, timestamp = Date.now()) {
    if (premiums?.atm) this._atm = premiums.atm;
    if (premiums?.exec?.ce) this._exec.ce = premiums.exec.ce;
    if (premiums?.exec?.pe) this._exec.pe = premiums.exec.pe;
    this.oiEngine.update(chainData);
    this.lastOI = this.oiEngine.getAnalysis(this.lastPrice);
    this._runAnalysis({ force: true });
  }

  _runAnalysis(ctx = {}) {
    const c5m = this.candleBuilder.getAllCandles(5, 200);
    const c15m = this.candleBuilder.getAllCandles(15, 100);
    const c30m = this.candleBuilder.getAllCandles(30, 50);
    if (c5m.length < 5) return;

    let atr14 = null, atr14_MA20 = null, regime = this.lastRegime;
    if (c5m.length >= 20) {
      atr14 = RegimeDetector.calcATR(c5m, 14);
      atr14_MA20 = this._calcATRMA20(c5m);
      regime = RegimeDetector.classifyRegime(atr14, atr14_MA20);
      this.lastRegime = regime;
      this.lastATR = atr14;
    }

    const indicators = getIndicators(c5m, c15m, c30m, this.vwap);
    if (!indicators) return;
    if (atr14 !== null) { indicators.atr14 = atr14; indicators.atr14_MA20 = atr14_MA20; }
    this.lastIndicators = indicators;

    const oiAnalysis = this.oiEngine.getAnalysis(this.lastPrice) || this.lastOI || {};
    this.lastOI = oiAnalysis;

    const state = this.marketStateEngine.classify(indicators, oiAnalysis, regime);
    this.lastState = state;

    const abort = this.abortEngine.checkAbort(this.lastPrice, Date.now());
    if (abort) this.onSetupAbort?.(abort);
    const confirm = this.abortEngine.checkConfirm(this.lastPrice, indicators.vwap?.vwap || this.lastPrice, indicators.volume?.current || 0, indicators.volume?.avg20 || 1, Date.now());
    if (confirm?.action === 'CONFIRM') { this._handleSetupConfirm(confirm, Date.now()); return; }

    const signal = this.signalEngine.evaluate(indicators, state, oiAnalysis, Date.now(), { ce: this._exec.ce?.premium, pe: this._exec.pe?.premium }, { exec: this._exec, atm: this._atm }, regime);

    if (signal) {
      signal.serverTime = Date.now();
      if (signal.signalStage === 'SETUP') {
        this.abortEngine.addSetup(signal, indicators.price, Date.now());
        this.onSignal?.(signal);
      } else if (signal.signalStage === 'CONFIRMED') {
        const premium = signal.entryPremium;
        if (premium) this.tradeManager.openTrade(signal, premium, signal.type === 'BUY_CE' ? this._exec.ce : this._exec.pe);
        this.onSignal?.(signal);
      }
    }

    this._lastAnalysisAt = Date.now();
    this.onUpdate?.({
      instrument: this.name,
      indicators: this._serializeIndicators(indicators),
      state,
      oi: oiAnalysis,
      trade: this.tradeManager.getState(),
      signals: this.signalEngine.getStats(),
      regime: regime?.regime || null,
      atr: atr14,
    });
  }

  _updateActiveTrade(ltp) {
    if (!this.tradeManager.activeTrade) return;
    const maxAge = 3000;
    const isFresh = (Date.now() - this._lastOptPremiumTs) < maxAge;
    if (isFresh && typeof this._lastOptPremium === 'number') {
      const closed = this.tradeManager.update(this._lastOptPremium);
      if (closed) this.onTradeClose?.(closed);
    }
  }

  _didFiveMinuteCandleRoll(slot) {
    if (!slot) return false;
    if (this._last5mSlot == null) { this._last5mSlot = slot; return false; }
    if (slot !== this._last5mSlot) { this._last5mSlot = slot; return true; }
    return false;
  }

  _serializeIndicators(ind) {
    return {
      price: ind.price, ema5: ind.ema?.ema5, ema9: ind.ema?.ema9, ema15: ind.ema?.ema15,
      vwap: ind.vwap?.vwap, bb: ind.bb?.['5m'], bias: ind.bias, candle: ind.candle?.last,
      atr14: ind.atr14, volume: ind.volume,
    };
  }

  _checkDayReset() {
    const today = new Date().toDateString();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this.candleBuilder.reset();
      this.vwap.reset();
      this.signalEngine.resetDay();
      this.tradeManager.resetDay();
      this.marketStateEngine.reset();
      this.abortEngine = new AbortEngine();
      this.oiEngine.reset();
    }
  }

  getSnapshot() {
    return {
      instrument: this.name,
      indicators: this.lastIndicators ? this._serializeIndicators(this.lastIndicators) : null,
      state: this.lastState,
      oi: this.lastOI,
      trade: this.tradeManager.getState(),
      signals: this.signalEngine.getStats(),
      regime: this.lastRegime?.regime || null,
      atr: this.lastATR,
      dna: this.dna.name,
    };
  }
}

// ── MULTI-INSTRUMENT MANAGER ─────────────────────────────────
class MultiInstrumentManager {
  constructor(instrumentNames = ['SENSEX']) {
    this.sessions = new Map();
    for (const name of instrumentNames) {
      if (INSTRUMENT_CONFIG[name]) this.addInstrument(name);
    }
  }

  addInstrument(name) {
    const session = new InstrumentOrchestrator(name);
    this.sessions.set(name, session);
    console.log(`🔧 Added instrument session: ${name}`);
    return session;
  }

  removeInstrument(name) {
    this.sessions.delete(name);
  }

  routeTick(instrumentName, ltp, timestamp) {
    const session = this.sessions.get(instrumentName);
    if (session) session.onTick(ltp, timestamp);
  }

  routeOptionChain(instrumentName, chainData, premiums, timestamp) {
    const session = this.sessions.get(instrumentName);
    if (session) session.onOptionChain(chainData, premiums, timestamp);
  }

  routeOptionLTP(instrumentName, premium, timestamp) {
    const session = this.sessions.get(instrumentName);
    if (session) session.onOptionLTP(premium, timestamp);
  }

  getSnapshot(instrumentName) {
    const session = this.sessions.get(instrumentName);
    return session ? session.getSnapshot() : null;
  }

  getAllSnapshots() {
    const result = {};
    for (const [name, session] of this.sessions) result[name] = session.getSnapshot();
    return result;
  }

  getSession(instrumentName) { return this.sessions.get(instrumentName); }
  getAllSessions() { return Array.from(this.sessions.values()); }
  getInstrumentNames() { return Array.from(this.sessions.keys()); }
}

module.exports = { MultiInstrumentManager, InstrumentOrchestrator, INSTRUMENT_CONFIG };
