// ============================================================
// INSTRUMENT ENGINE
// Per-instrument signal engine — fully independent, no shared state
// ============================================================

const { CandleBuilder } = require('../candleBuilder');
const { calculateIndicators } = require('../indicators');
const { MarketStateEngineClass, STATES } = require('../marketStateEngine');
const { OIEngine } = require('../oiEngine');
const { SignalEngine } = require('../signalEngine');
const { TradeManager } = require('../tradeManager');
const { AbortEngine } = require('../abortEngine');
const DataFreshness = require('../dataFreshness');
const GreeksCalculator = require('../greeksCalculator');
const SignalCalibrator = require('../signalCalibrator');
const { EarlyEntryDetector } = require('../earlyEntryDetector');
const { createExpiryCalculator } = require('../utils/expiryCalculator');
const logger = require('../../logger');

// Defensive imports — some original modules export singletons, not classes
let VWAPCalculator;
try {
  const indicators = require('../indicators');
  VWAPCalculator = indicators.VWAPCalculator || indicators.VWAP || null;
} catch (e) { VWAPCalculator = null; }

let RegimeDetector;
try {
  RegimeDetector = require('../regimeDetector');
  // If it's a singleton instance (not a constructor), wrap it
  if (RegimeDetector && typeof RegimeDetector !== 'function') {
    const singleton = RegimeDetector;
    RegimeDetector = function() { return singleton; };
  }
} catch (e) {
  RegimeDetector = function() {
    return { detect: () => ({ trend: 'NEUTRAL', strength: 0 }), reset: () => {} };
  };
}

class InstrumentEngine {
  constructor(instrumentId, profile, brokerConfig) {
    this.id = instrumentId;
    this.profile = profile;
    this.brokerConfig = brokerConfig;

    // Fresh instances — NO shared state with other instruments
    this.expiryCalc = createExpiryCalculator(profile);
    this.candleBuilder = new CandleBuilder();
    this.vwap = VWAPCalculator ? new VWAPCalculator() : { tick: () => {}, reset: () => {} };
    this.marketState = new MarketStateEngineClass();
    this.oiEngine = new OIEngine();
    this.signalEngine = new SignalEngine();
    this.tradeManager = new TradeManager();
    this.abortEngine = new AbortEngine();
    this.dataFreshness = new DataFreshness();
    this.greeks = new GreeksCalculator();
    this.calibrator = new SignalCalibrator();
    this.earlyEntry = new EarlyEntryDetector();
    this.regimeDetector = new RegimeDetector();

    // State tracking
    this.lastIndicators = null;
    this.lastState = null;
    this.lastOI = null;
    this.lastRegime = null;
    this.lastATR = null;
    this.lastPrice = null;
    this._last5mSlot = null;
    this._lastAnalysisAt = 0;
    this._lastOptPremium = null;
    this._lastOptPremiumTs = 0;
    this._exec = { ce: null, pe: null };
    this._atm = null;
    this._lastResetDate = null;

    // Callbacks (set by parent MultiOrchestrator)
    this.onSignal = null;
    this.onTradeOpen = null;
    this.onTradeClose = null;
    this.onUpdate = null;
    this.onSetupAbort = null;

    // Override signal engine limits from profile
    this.signalEngine.maxSignals = profile.maxSignalsDay || 5;
    this.signalEngine.maxTrades = profile.maxTradesDay || 3;
    this.signalEngine.cooldownMs = profile.cooldownMs || 300000;

    logger.info(`InstrumentEngine initialized: ${instrumentId} (${profile.name})`);
  }

  onTick(ltp, timestamp) {
    this._checkDayReset();
    this.candleBuilder.tick(ltp, timestamp);
    try { this.vwap.tick(ltp, timestamp); } catch (_) {}

    const candles5m = this.candleBuilder.getCandles(5, 50);
    const candles15m = this.candleBuilder.getCandles(15, 50);
    const candles3m = this.candleBuilder.getCandles(3, 50);

    if (candles5m.length < 3) return;

    let indicators;
    try {
      indicators = calculateIndicators(candles5m, candles15m, candles3m, ltp);
    } catch (err) {
      logger.error(`[${this.id}] Indicator calculation error: ${err.message}`);
      return;
    }
    this.lastIndicators = indicators;
    this.lastPrice = ltp;
    if (indicators.atr) this.lastATR = indicators.atr;

    let state;
    try {
      state = this.marketState.update(indicators, candles5m);
    } catch (err) {
      logger.error(`[${this.id}] MarketState error: ${err.message}`);
      state = { state: 'UNKNOWN', confidence: 0 };
    }
    this.lastState = state;

    let regime;
    try {
      regime = this.regimeDetector.detect(candles5m, indicators);
    } catch (err) {
      regime = { trend: 'NEUTRAL', strength: 0 };
    }
    this.lastRegime = regime;

    this._updateActiveTrade(ltp);

    const now = Date.now();
    if (now - this._lastAnalysisAt > 5000) {
      this._lastAnalysisAt = now;
      this._runAnalysis({ ltp, timestamp, indicators, state, regime, candles5m });
    }
  }

  onOptionChain(chainData, premiums, timestamp) {
    this._checkDayReset();
    const oiSnapshot = this.oiEngine.update(chainData);
    if (!oiSnapshot) return;

    this.lastOI = oiSnapshot;

    if (this.lastPrice && oiSnapshot) {
      try {
        const oiAnalysis = this.oiEngine.getAnalysis(this.lastPrice);
        this.lastOI = oiAnalysis;
      } catch (err) {
        logger.error(`[${this.id}] OI analysis error: ${err.message}`);
      }
    }

    if (premiums && premiums.ce && premiums.pe) {
      this._exec = premiums;
      this._lastOptPremiumTs = Date.now();
    }
  }

  onOptionLTP(premium, timestamp) {
    this._lastOptPremium = premium;
    this._lastOptPremiumTs = timestamp;
  }

  _runAnalysis(ctx) {
    const { ltp, timestamp, indicators, state, regime, candles5m } = ctx;

    if (!this.lastOI) return;

    let oiAnalysis;
    try {
      oiAnalysis = this.oiEngine.getAnalysis(ltp);
    } catch (err) {
      logger.error(`[${this.id}] OI getAnalysis error: ${err.message}`);
      return;
    }
    if (!oiAnalysis) return;

    let signal;
    try {
      signal = this.signalEngine.evaluate({
        indicators,
        marketState: state,
        oiAnalysis,
        regime,
        price: ltp,
        timestamp,
        profile: this.profile,
      });
    } catch (err) {
      logger.error(`[${this.id}] Signal evaluation error: ${err.message}`);
      signal = null;
    }

    if (signal) {
      if (this.onSignal) {
        try { this.onSignal(this.id, signal); } catch (err) {
          logger.error(`[${this.id}] onSignal callback error: ${err.message}`);
        }
      }

      const premium = signal.type === 'BUY_CE'
        ? (this._exec?.ce?.premium || 0)
        : (this._exec?.pe?.premium || 0);

      if (premium > 0) {
        let trade;
        try {
          trade = this.tradeManager.openTrade(signal, premium, this.profile.lotSize, this.profile);
        } catch (err) {
          logger.error(`[${this.id}] Trade open error: ${err.message}`);
          trade = null;
        }
        if (trade && this.onTradeOpen) {
          try { this.onTradeOpen(this.id, trade); } catch (err) {
            logger.error(`[${this.id}] onTradeOpen callback error: ${err.message}`);
          }
        }
      }
    }

    // Abort check
    let abort;
    try {
      abort = this.abortEngine.check({
        price: ltp,
        indicators,
        marketState: state,
        oiAnalysis,
        regime,
        signal,
        timestamp,
      });
    } catch (err) {
      logger.error(`[${this.id}] Abort check error: ${err.message}`);
      abort = null;
    }

    if (abort && this.onSetupAbort) {
      try { this.onSetupAbort(this.id, abort); } catch (err) {
        logger.error(`[${this.id}] onSetupAbort callback error: ${err.message}`);
      }
    }

    // Update broadcast
    if (this.onUpdate) {
      try {
        this.onUpdate(this.id, {
          indicators,
          state,
          oi: oiAnalysis,
          regime,
          trade: this.tradeManager.getStats(),
          signals: this.signalEngine.getSignals(),
          price: ltp,
          timestamp,
          atmStrike: this._exec?.atmStrike || null,
        });
      } catch (err) {
        logger.error(`[${this.id}] onUpdate callback error: ${err.message}`);
      }
    }
  }

  _updateActiveTrade(ltp) {
    if (!this.tradeManager.activeTrade || !this._lastOptPremium) return;

    let result;
    try {
      result = this.tradeManager.updateTrade(this._lastOptPremium, ltp);
    } catch (err) {
      logger.error(`[${this.id}] Trade update error: ${err.message}`);
      return;
    }
    if (result && !result.updated && this.onTradeClose) {
      try { this.onTradeClose(this.id, result); } catch (err) {
        logger.error(`[${this.id}] onTradeClose callback error: ${err.message}`);
      }
    }
  }

  _checkDayReset() {
    const now = new Date();
    const today = now.toDateString();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      try { this.candleBuilder.reset(); } catch (_) {}
      try { this.marketState.reset(); } catch (_) {}
      try { this.oiEngine.reset(); } catch (_) {}
      try { this.signalEngine.reset(); } catch (_) {}
      try { this.tradeManager.reset(); } catch (_) {}
      try { this.dataFreshness.reset(); } catch (_) {}
      try { this.greeks.reset(); } catch (_) {}
      try { this.calibrator.reset(); } catch (_) {}
      try { this.earlyEntry.reset(); } catch (_) {}
      try { this.abortEngine.reset(); } catch (_) {}
      try { this.regimeDetector.reset(); } catch (_) {}
      this.lastIndicators = null;
      this.lastState = null;
      this.lastOI = null;
      this.lastRegime = null;
      this.lastATR = null;
      this.lastPrice = null;
      this._last5mSlot = null;
      this._lastAnalysisAt = 0;
      this._lastOptPremium = null;
      this._lastOptPremiumTs = 0;
      this._exec = { ce: null, pe: null };
      this._atm = null;
      logger.info(`InstrumentEngine reset for new day: ${this.id}`);
    }
  }

  getSnapshot() {
    return {
      id: this.id,
      name: this.profile.name,
      price: this.lastPrice,
      indicators: this.lastIndicators,
      state: this.lastState,
      oi: this.lastOI,
      regime: this.lastRegime,
      trade: this.tradeManager.getStats(),
      signals: this.signalEngine.getSignals(),
      atmStrike: this._exec?.atmStrike || null,
      timestamp: Date.now(),
    };
  }
}

module.exports = { InstrumentEngine };
