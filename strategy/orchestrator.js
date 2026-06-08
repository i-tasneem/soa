// ============================================================
// ORCHESTRATOR (LEGACY — SINGLE-INSTRUMENT MODE)
// Still works for backward compatibility
// FIX: Updated indicator property access, IST day reset
// ============================================================

const candleBuilder = require('./candleBuilder');
const { MarketStateEngine, STATES } = require('./marketStateEngine');
const oiEngine = require('./oiEngine');
const signalEngine = require('./signalEngine');
const tradeManager = require('./tradeManager');
const dataFreshness = require('./dataFreshness');
const greeks = require('./greeksCalculator');
const calibrator = require('./signalCalibrator');
const earlyEntry = require('./earlyEntryDetector');
const abortEngine = require('./abortEngine');
const regimeDetector = require('./regimeDetector');
const { calculateIndicators } = require('./indicators');
const logger = require('../logger');

class Orchestrator {
  constructor() {
    this.marketState = MarketStateEngine;
    this.oiEngine = oiEngine;
    this.signalEngine = signalEngine;
    this.tradeManager = tradeManager;
    this.dataFreshness = dataFreshness;
    this.greeks = greeks;
    this.calibrator = calibrator;
    this.earlyEntry = earlyEntry;
    this.abortEngine = abortEngine;
    this.regimeDetector = regimeDetector;

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

    this.onSignal = null;
    this.onTradeOpen = null;
    this.onTradeClose = null;
    this.onUpdate = null;
    this.onSetupAbort = null;
  }

  onTick(ltp, timestamp) {
    this._checkDayReset();
    candleBuilder.tick(ltp, timestamp);

    const candles5m = candleBuilder.getCandles(5, 50);
    const candles15m = candleBuilder.getCandles(15, 50);
    const candles30m = candleBuilder.getCandles(30, 50);

    if (candles5m.length < 3) return;

    const indicators = calculateIndicators(candles5m, candles15m, candles30m, null);
    this.lastIndicators = indicators;
    this.lastPrice = ltp;

    const state = this.marketState.update(indicators, candles5m);
    this.lastState = state;

    const regime = this.regimeDetector.detect(candles5m, indicators);
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
      const oiAnalysis = this.oiEngine.getAnalysis(this.lastPrice);
      this.lastOI = oiAnalysis;
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

    const oiAnalysis = this.oiEngine.getAnalysis(ltp);
    if (!oiAnalysis) return;

    const signal = this.signalEngine.evaluate({
      indicators,
      marketState: state,
      oiAnalysis,
      regime,
      price: ltp,
      timestamp,
    });

    if (signal) {
      if (this.onSignal) this.onSignal(signal);

      const premium = signal.type === 'BUY_CE' ? (this._exec?.ce?.premium || 0) : (this._exec?.pe?.premium || 0);
      if (premium > 0) {
        const trade = this.tradeManager.openTrade(signal, premium, 15, null);
        if (trade && this.onTradeOpen) {
          this.onTradeOpen(trade);
        }
      }
    }

    // Abort check
    const abort = this.abortEngine.check({
      price: ltp,
      indicators,
      marketState: state,
      oiAnalysis,
      regime,
      signal,
      timestamp,
    });

    if (abort && this.onSetupAbort) {
      this.onSetupAbort(abort);
    }

    // Update
    if (this.onUpdate) {
      this.onUpdate({
        indicators,
        state,
        oi: oiAnalysis,
        regime,
        trade: this.tradeManager.getStats(),
        signals: this.signalEngine.getSignals(),
        price: ltp,
        timestamp,
      });
    }
  }

  _updateActiveTrade(ltp) {
    if (!this.tradeManager.activeTrade || !this._lastOptPremium) return;

    const result = this.tradeManager.updateTrade(this._lastOptPremium, ltp);
    if (result && !result.updated && this.onTradeClose) {
      this.onTradeClose(result);
    }
  }

  _checkDayReset() {
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      candleBuilder.reset();
      this.marketState.reset();
      this.oiEngine.reset();
      this.signalEngine.reset();
      this.tradeManager.reset();
      this.dataFreshness.reset();
      this.greeks.reset();
      this.calibrator.reset();
      this.earlyEntry.reset();
      this.abortEngine.reset();
      this.regimeDetector.reset();
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
      console.log('🔄 Orchestrator reset for new day');
    }
  }

  getSnapshot() {
    return {
      indicators: this.lastIndicators,
      state: this.lastState,
      oi: this.lastOI,
      regime: this.lastRegime,
      trade: this.tradeManager.getStats(),
      signals: this.signalEngine.getSignals(),
      price: this.lastPrice,
      timestamp: Date.now(),
    };
  }
}

module.exports = new Orchestrator();
module.exports.Orchestrator = Orchestrator;
