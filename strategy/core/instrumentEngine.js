// ============================================================
// INSTRUMENT ENGINE
// Per-instrument signal engine — fully independent, no shared state
// ============================================================

const { CandleBuilder } = require('../candleBuilder');
const { calculateIndicators } = require('../indicators');
const { VWAPCalculator } = require('../indicators');
const { MarketStateEngineClass, STATES } = require('../marketStateEngine');
const { OIEngine } = require('../oiEngine');
const { SignalEngine } = require('../signalEngine');
const { TradeManager } = require('../tradeManager');
const { AbortEngine } = require('../abortEngine');
const DataFreshness = require('../dataFreshness');
const GreeksCalculator = require('../greeksCalculator');
const SignalCalibrator = require('../signalCalibrator');
const { EarlyEntryDetector } = require('../earlyEntryDetector');
const RegimeDetector = require('../regimeDetector');
const { createExpiryCalculator } = require('../utils/expiryCalculator');
const logger = require('../../logger');

class InstrumentEngine {
  constructor(instrumentId, profile, brokerConfig) {
    this.id = instrumentId;
    this.profile = profile;
    this.brokerConfig = brokerConfig;

    // Fresh instances — NO shared state with other instruments
    this.expiryCalc = createExpiryCalculator(profile);
    this.candleBuilder = new CandleBuilder();
    this.vwap = new VWAPCalculator();
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

    const candles5m = this.candleBuilder.getCandles(5, 50);
    const candles15m = this.candleBuilder.getCandles(15, 50);
    const candles3m = this.candleBuilder.getCandles(3, 50);

    if (candles5m.length < 3) return;

    const indicators = calculateIndicators(candles5m, candles15m, candles3m, ltp);
    this.lastIndicators = indicators;
    this.lastPrice = ltp;
    if (indicators.atr) this.lastATR = indicators.atr;

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
      profile: this.profile,
    });

    if (signal) {
      if (this.onSignal) this.onSignal(this.id, signal);

      const premium = signal.type === 'BUY_CE'
        ? (this._exec?.ce?.premium || 0)
        : (this._exec?.pe?.premium || 0);

      if (premium > 0) {
        const trade = this.tradeManager.openTrade(signal, premium, this.profile.lotSize, this.profile);
        if (trade && this.onTradeOpen) {
          this.onTradeOpen(this.id, trade);
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
      this.onSetupAbort(this.id, abort);
    }

    // Update broadcast
    if (this.onUpdate) {
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
    }
  }

  _updateActiveTrade(ltp) {
    if (!this.tradeManager.activeTrade || !this._lastOptPremium) return;

    const result = this.tradeManager.updateTrade(this._lastOptPremium, ltp);
    if (result && !result.updated && this.onTradeClose) {
      this.onTradeClose(this.id, result);
    }
  }

  _checkDayReset() {
    const now = new Date();
    const today = now.toDateString();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this.candleBuilder.reset();
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
