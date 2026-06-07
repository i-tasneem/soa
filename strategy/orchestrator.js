// ============================================================
// ORCHESTRATOR — Phase 1 replacement
// ============================================================
const candleBuilder = require('./candleBuilder');
const { getIndicators, VWAPCalculator } = require('./indicators');
const { MarketStateEngine } = require('./marketStateEngine');
const oiEngine = require('./oiEngine');
const signalEngine = require('./signalEngine');
const tradeManager = require('./tradeManager');
const config = require('../config');
const DataFreshness = require('./dataFreshness');
const GreeksCalculator = require('./greeksCalculator');
const SignalCalibrator = require('./signalCalibrator');
const database = require('../database');
const earlyEntryDetector = require('./earlyEntryDetector');

class Orchestrator {
  constructor() {
    this.vwap = new VWAPCalculator();
    this.dataFreshness = new DataFreshness(config.feeds || {});
    this.lastIndicators = null;
    this.lastState = null;
    this.lastOI = null;
    this.lastOISnapshot = null;
    this.lastSensex = null;
    this.onSignal = null;
    this.onUpdate = null;
	this.onTradeOpen = null;
    this.onTradeClose = null;
    this.onDayReset = null;
    this.lastResetDate = null;
    this._atm = { strike: null, call: null, put: null };
    this._exec = { ce: { strike: null, premium: null, token: null, expiry: null }, pe: { strike: null, premium: null, token: null, expiry: null } };
    this._lastOptPremium = null;
    this._lastOptPremiumTs = 0;
    this._execTs = 0;
    this._atmTs = 0;
    this._last5mSlot = null;
    this._lastAnalysisAt = 0;
    this._analysisRunning = false;
    this._analysisQueued = false;
	this.greeks = new GreeksCalculator(config.greeks || {});
	this.calibrator = new SignalCalibrator(config.calibration || {});
	this._lastGreeks = null;
	this._calibrationMeta = { updatedAt: 0, byType: {} };
    this._lastCalibrationLoadAt = 0;
  }

  onTick(ltp, timestamp = Date.now()) {
    if (typeof ltp !== 'number') return;
    this._checkDayReset();
    this.lastSensex = ltp;
    this.dataFreshness.update('sensex_ltp', timestamp, { ltp });
    candleBuilder.tick(ltp, timestamp);
    const cur5m = candleBuilder.getCurrent(5);
    if (cur5m) this.vwap.update(cur5m);
    this._updateActiveTrade(ltp);
    const rolled = this._didFiveMinuteCandleRoll(cur5m?.time);
    const staleAnalysis = Date.now() - this._lastAnalysisAt >= (config.analysis?.maxAnalysisAgeMs ?? 10000);
    if (rolled || staleAnalysis) this._scheduleAnalysis('tick', { ltp, rolled, staleAnalysis });
  }

  onOptionLTP(premium, timestamp = Date.now()) {
    if (typeof premium !== 'number') return;
    this._lastOptPremium = premium;
    this._lastOptPremiumTs = timestamp;
    this.dataFreshness.update('option_ltp', timestamp, { premium });
  }

  onOptionChain(chainData, premiums, timestamp = Date.now()) {
    if (premiums?.atm) this._atm = premiums.atm;
    if (premiums?.exec?.ce) this._exec.ce = premiums.exec.ce;
    if (premiums?.exec?.pe) this._exec.pe = premiums.exec.pe;
    this._execTs = timestamp;
    this._atmTs = timestamp;
    this.dataFreshness.update('option_chain', timestamp, { rows: Array.isArray(chainData) ? chainData.length : 0 });
    this.lastOISnapshot = oiEngine.update(chainData);
    const px = this.lastIndicators?.price || this.lastSensex;
    if (typeof px === 'number') this.lastOI = oiEngine.getAnalysis(px);
    this._scheduleAnalysis('option_chain', { force: true });
  }

  _scheduleAnalysis(reason = 'manual', ctx = {}) {
    const now = Date.now();
    const throttleMs = config.analysis?.throttleMs ?? 200;
    const force = !!ctx.force || (now - this._lastAnalysisAt >= (config.analysis?.maxAnalysisAgeMs ?? 10000));
    if (!force && now - this._lastAnalysisAt < throttleMs) return;
    if (this._analysisRunning) { this._analysisQueued = true; return; }
    this._analysisRunning = true;
    try { this._runAnalysis({ reason, ...ctx }); }
    finally {
      this._analysisRunning = false;
      if (this._analysisQueued) { this._analysisQueued = false; setImmediate(() => this._scheduleAnalysis('queued', { force: true })); }
    }
  }
  
  _loadCalibrationStats(force = false) {
    if (!config.calibration?.enabled) {
      return { updatedAt: 0, byType: {} };
    }

    const now = Date.now();
    const refreshMs = Number(config.calibration?.refreshMs ?? 60000);
    if (!force && this._calibrationMeta?.updatedAt && (now - this._lastCalibrationLoadAt) < refreshMs) {
      return this._calibrationMeta;
    }

    try {
      const limit = Number(config.calibration?.lookbackSignals ?? 200);
      const rows = typeof database.getCalibrationSignals === 'function'
        ? database.getCalibrationSignals(limit)
        : database.getRecentSignals(limit);

      const safeRows = Array.isArray(rows) ? rows : [];
      this._calibrationMeta = this.calibrator.build(safeRows) || { updatedAt: 0, byType: {} };
      this._lastCalibrationLoadAt = now;
      return this._calibrationMeta;
    } catch (err) {
      this._calibrationMeta = { updatedAt: now, byType: {} };
      this._lastCalibrationLoadAt = now;
      return this._calibrationMeta;
    }
  }

  _runAnalysis(ctx = {}) {
    const c5m = candleBuilder.getAllCandles(5, 200);
    const c15m = candleBuilder.getAllCandles(15, 100);
    const c30m = candleBuilder.getAllCandles(30, 50);
    if (c5m.length < 5) return;
    const indicators = getIndicators(c5m, c15m, c30m, this.vwap);
    if (!indicators) return;
    this.lastIndicators = indicators;
    this.dataFreshness.update('indicators', Date.now(), { price: indicators.price });
    const oiAnalysis = oiEngine.getAnalysis(indicators.price) || this.lastOI || {};
    this.lastOI = oiAnalysis;
    const now = Date.now();
    const feedAges = this.dataFreshness.getStaleReport(now);
	
	// ✅ EARLY ENTRY FIRST
	const early = earlyEntryDetector.detect(
	indicators,
	oiAnalysis,
	this.lastIndicators
	);
	
	if (early && early.confidence > 80) {
	const canTrade = tradeManager.canOpenNewTrade();
	
	if (canTrade.allowed) {
		const signal = {
		id: `EARLY_${Date.now()}`,
		type: early.direction,
		confidence: early.confidence,
		factors: [{ name: early.reason }]
		};
	
		const trade = tradeManager.openTrade(
		signal,
		this._getExecPremiums()[early.direction === 'BUY_CE' ? 'ce' : 'pe'],
		this._getExecMeta(early.direction),
		{ early: true, reason: early.reason }
		);
	
		if (trade && this.onSignal) {
		this.onSignal(trade);
		}
	}
	
	return; // 🛑 STOP normal signal flow
	}
	this.lastIndicators = indicators;
    if (oiAnalysis && typeof oiAnalysis === 'object') {
      oiAnalysis.feedAges = feedAges;
      oiAnalysis.stale = !!feedAges.option_chain?.isStale;
      oiAnalysis.oiAgeMs = feedAges.option_chain?.ageMs ?? null;
      oiAnalysis.premiumsStale = !!feedAges.option_ltp?.isStale && !!tradeManager.activeTrade;
      oiAnalysis.premAgeMs = feedAges.option_ltp?.ageMs ?? null;
    }
    this.dataFreshness.checkAll(now);
    const state = MarketStateEngine.classify(indicators, oiAnalysis);
    this.lastState = state;

    let signal = signalEngine.evaluate(
      indicators,
      state,
      oiAnalysis,
      now,
      this._getExecPremiums(),
      {
        exec: this._exec,
        atm: this._atm,
        feedAges,
        analysisReason: ctx.reason || 'unknown',
        serverTime: now
      }
    );

    const imbalanceMeta = oiAnalysis?.imbalance || {
      score: Number(oiAnalysis?.imbalanceScore ?? 0) || 0,
      bias: oiAnalysis?.imbalanceBias || 'NEUTRAL',
      totalCEoi: Number(oiAnalysis?.totalCEoi ?? 0),
      totalPEoi: Number(oiAnalysis?.totalPEoi ?? 0)
    };

    if (signal) {
      signal.rawConfidence = Number(signal.rawConfidence ?? signal.confidence ?? 0);
      signal.imbalance = signal.imbalance || {
        score: Number(imbalanceMeta.score ?? 0) || 0,
        bias: imbalanceMeta.bias || 'NEUTRAL',
        appliedBoost: Number(signal.imbalance?.appliedBoost ?? 0) || 0,
        totalCEoi: Number(imbalanceMeta.totalCEoi ?? 0),
        totalPEoi: Number(imbalanceMeta.totalPEoi ?? 0)
      };
    }

    if (signal && config.calibration?.enabled) {
      const calibrationCache = this._loadCalibrationStats();
      const adjusted = this.calibrator.adjust(signal);

      signal = {
        ...adjusted,
        rawConfidence: Number(signal.rawConfidence ?? signal.confidence ?? 0),
        imbalance: adjusted.imbalance || signal.imbalance,
        calibration: {
          ...(adjusted.calibration || {}),
          enabled: true,
          stats: this.calibrator.getStats?.(adjusted.type) || null,
          updatedAt: calibrationCache?.updatedAt || 0
        }
      };
    } else if (signal) {
      signal.calibration = {
        enabled: false,
        applied: false,
        reason: 'disabled'
      };
    }

    this._lastAnalysisAt = now;

    if (signal) {
      signal.serverTime = now;
      signal.feedAges = feedAges;

      if (!signal.nearMiss) {
        const premium = signal.entryPremium;
        if (premium) tradeManager.openTrade(signal, premium, this._getExecMeta(signal.type));
      }

      this.onSignal?.(signal);
    }

    this.onUpdate?.({
      indicators: this._serializeIndicators(indicators),
      state,
      oi: oiAnalysis,
      trade: tradeManager.getState(),
      signals: signalEngine.getStats(),
      contracts: { exec: this._exec, atm: this._atm },
      feedAges,
      calibration: config.calibration?.enabled ? this.calibrator.getSnapshot?.() : null,
      analysis: { reason: ctx.reason || 'unknown', lastAnalysisAt: now }
    });
  }

  _updateActiveTrade(ltp) {
  if (!tradeManager.activeTrade) return;

  const maxAge = config.feeds?.option_ltp?.maxStaleMs ?? 3000;
  const isFresh = (Date.now() - this._lastOptPremiumTs) < maxAge;

  if (isFresh && typeof this._lastOptPremium === 'number') {
    const closed = tradeManager.update(this._lastOptPremium);
    if (closed) this.onTradeClose?.(closed);
    return;
  }

  const contract = tradeManager.activeTrade.optionToken
    ? (tradeManager.activeTrade.type === 'BUY_CE' ? this._exec.ce : this._exec.pe)
    : null;

  const greeks = this.greeks.calculate({
    spot: ltp,
    strike: contract?.strike || tradeManager.activeTrade.strike,
    type: tradeManager.activeTrade.type,
    expiry: contract?.expiry || tradeManager.activeTrade.expiry,
    iv: config.greeks?.defaultIv,
  });

  this._lastGreeks = greeks;

  const safePrem = greeks?.premium || this.greeks.estimatePremiumFromMove({
    entryPremium: tradeManager.activeTrade.entryPremium,
    entrySpot: tradeManager.activeTrade.entryPrice,
    currentSpot: ltp,
    type: tradeManager.activeTrade.type,
    delta: greeks?.delta ?? 0.5,
  });

  const closed = tradeManager.update(safePrem);
  if (closed) this.onTradeClose?.(closed);
}

  _didFiveMinuteCandleRoll(slot) {
    if (!slot) return false;
    if (this._last5mSlot == null) { this._last5mSlot = slot; return false; }
    if (slot !== this._last5mSlot) { this._last5mSlot = slot; return true; }
    return false;
  }

  _getExecPremiums() { return { ce: this._exec.ce?.premium ?? null, pe: this._exec.pe?.premium ?? null }; }
  _getExecMeta(type) { return type === 'BUY_CE' ? this._exec.ce : type === 'BUY_PE' ? this._exec.pe : null; }

  _serializeIndicators(ind) {
    return { price: ind.price, ema5: ind.ema.ema5, ema9: ind.ema.ema9, ema15: ind.ema.ema15, ema50: ind.ema.ema50, vwap: ind.vwap?.vwap, bb: { upper: ind.bb?.['5m']?.upper, lower: ind.bb?.['5m']?.lower, mid: ind.bb?.['5m']?.middle, squeeze: ind.bb?.['5m']?.squeeze, bw: ind.bb?.['5m']?.bandwidth }, bias: ind.bias, candle: { bullish: ind.candle?.last?.bullish, strong: ind.candle?.last?.isStrong, doji: ind.candle?.last?.isDoji } };
  }

  _checkDayReset() {
    const today = new Date().toDateString();
    if (this.lastResetDate !== today) {
      this.lastResetDate = today;
      this.vwap.reset();
      candleBuilder.reset();
      signalEngine.resetDay();
      tradeManager.resetDay();
      console.log('🌅 New day reset — fetching historical candles...');
      this.onDayReset?.();
    }
  }

  getSnapshot() {
    return { indicators: this.lastIndicators ? this._serializeIndicators(this.lastIndicators) : null, state: this.lastState, oi: this.lastOI, oiSnapshot: this.lastOISnapshot, trade: tradeManager.getState(), signals: signalEngine.getStats(), contracts: { exec: this._exec, atm: this._atm }, feedAges: this.dataFreshness.getStaleReport(), lastAnalysisAt: this._lastAnalysisAt };
  }
}
module.exports = new Orchestrator();
