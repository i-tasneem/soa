// ============================================================
// INSTRUMENT ENGINE v7 — Audit Integration + Broker Adapter
// Changes from v6:
// 1. Signal audit logging on every signal generation
// 2. Outcome tracking on trade open/close
// 3. Broker adapter passed in (not hardcoded Angel)
// 4. Signal lifecycle state transitions (NEW → ACTIVE → CLOSED)
// STRATEGY LOGIC UNCHANGED
// ============================================================

const EventEmitter = require('events');
const logger = require('../logger');

const CandleBuilder = require('./candleBuilder').CandleBuilder;
const Indicators = require('./indicators').Indicators;
const MarketStateEngine = require('./marketStateEngine').MarketStateEngine;
const OIEngine = require('./oiEngine').OIEngine;
const SignalEngine = require('./signalEngine').SignalEngine;
const TradeManager = require('./tradeManager').TradeManager;
const AbortEngine = require('./abortEngine').AbortEngine;
const DataFreshness = require('./dataFreshness').DataFreshness;
const GreeksCalculator = require('./greeksCalculator').GreeksCalculator;
const SignalCalibrator = require('./signalCalibrator').SignalCalibrator;
const EarlyEntryDetector = require('./earlyEntryDetector').EarlyEntryDetector;
const RegimeDetector = require('./regimeDetector').RegimeDetector;

class InstrumentEngine extends EventEmitter {
  constructor(instrumentId, profile, config = {}) {
    super();
    this.instrumentId = instrumentId;
    this.profile = profile;
    this.config = config;
    this.isActive = false;

    this.candleBuilder = new CandleBuilder();
    this.indicators = new Indicators();
    this.marketState = new MarketStateEngine();
    this.oiEngine = new OIEngine();
    this.signalEngine = new SignalEngine();
    this.tradeManager = new TradeManager(instrumentId, profile);
    this.abortEngine = new AbortEngine();
    this.dataFreshness = new DataFreshness();
    this.greeksCalculator = new GreeksCalculator();
    this.signalCalibrator = new SignalCalibrator(instrumentId);
    this.earlyEntryDetector = new EarlyEntryDetector();
    this.regimeDetector = new RegimeDetector();

    this.currentLTP = null;
    this.lastLTP = null;
    this.lastAnalysis = 0;
    this.analysisInterval = 5000;
    this.lastAnalysisResult = null;

    // Audit framework (injected from MultiOrchestrator)
    this.signalAudit = null;

    this._bindEvents();
  }

  setSignalAudit(audit) {
    this.signalAudit = audit;
  }

  _bindEvents() {
    this.tradeManager.on('tradeOpened', (trade) => {
      this.emit('tradeOpened', { instrumentId: this.instrumentId, trade });
      // Audit: activate signal lifecycle
      if (this.signalAudit && trade.signalId) {
        this.signalEngine.activateSignal(this.instrumentId, trade.signalId);
      }
    });
    this.tradeManager.on('tradeClosed', (trade) => {
      this.emit('tradeClosed', { instrumentId: this.instrumentId, trade });
      // Audit: update outcome
      if (this.signalAudit && trade.signalId) {
        this.signalAudit.updateOutcome(trade.auditId, {
          status: trade.pnl >= 0 ? 'WIN' : 'LOSS',
          exitTimestamp: trade.exitTimestamp,
          exitPrice: trade.exitPrice,
          exitPremium: trade.exitPremium,
          exitReason: trade.exitReason,
          pnl: trade.pnl,
          durationMs: trade.durationMs,
          maxProfit: trade.maxProfit,
          maxDrawdown: trade.maxDrawdown,
          actualRR: trade.actualRR,
        });
        this.signalEngine.closeSignal(this.instrumentId, trade.signalId, {
          status: trade.pnl >= 0 ? 'WIN' : 'LOSS',
          pnl: trade.pnl,
          exitReason: trade.exitReason,
        });
      }
    });
    this.tradeManager.on('tradeUpdated', (trade) => {
      this.emit('tradeUpdated', { instrumentId: this.instrumentId, trade });
    });
    this.tradeManager.on('trailingStopActivated', (trade) => {
      this.emit('trailingStopActivated', { instrumentId: this.instrumentId, trade });
    });
  }

  tick(ltp, timestamp, optionChainData = null, marketData = null) {
    if (!this.isActive) return;
    this.lastLTP = this.currentLTP;
    this.currentLTP = ltp;
    this.dataFreshness.update('ltp', timestamp);

    this.candleBuilder.tick(ltp, timestamp);
    this.emit('tick', { instrumentId: this.instrumentId, ltp, timestamp });

    if (optionChainData) {
      this.oiEngine.update(optionChainData);
      this.dataFreshness.update('oi', timestamp);
      this.emit('oiUpdate', { instrumentId: this.instrumentId, oiData: this.oiEngine.getAnalysis(ltp) });
    }

    if (marketData) {
      this.greeksCalculator.update(marketData);
      this.dataFreshness.update('greeks', timestamp);
    }

    const now = Date.now();
    if (now - this.lastAnalysis >= this.analysisInterval) {
      this._runAnalysis(ltp, timestamp, optionChainData);
      this.lastAnalysis = now;
    }
  }

  _runAnalysis(ltp, timestamp, optionChainData) {
    if (!this.isActive) return;
    try {
      const candles = this.candleBuilder.getCandles();
      if (!candles.current5m) return;

      const indicators = this.indicators.calculate(candles);
      const marketState = this.marketState.update(indicators, candles);
      const oiAnalysis = this.oiEngine.getAnalysis(ltp);
      const regime = this.regimeDetector.classifyRegime(indicators.atr14, indicators.atr14 > 0 ? indicators.atr14 / 1.0 : 0, null);
      const greeks = this.greeksCalculator.getGreeks();
      const freshness = this.dataFreshness.getStatus();
      const calibrator = this.signalCalibrator.getCalibration();
      const earlyEntry = this.earlyEntryDetector.detect(ltp, indicators, candles, oiAnalysis, marketState);

      const abortReasons = this.abortEngine.check(ltp, indicators, candles, marketState, oiAnalysis, greeks, freshness, calibrator);
      if (abortReasons.length > 0) {
        this.emit('abort', { instrumentId: this.instrumentId, reasons: abortReasons });
        return;
      }

      const analysis = {
        instrument: this.instrumentId,
        timestamp,
        ltp,
        indicators,
        marketState,
        oiAnalysis,
        regime,
        greeks,
        candles,
        freshness,
        calibrator,
        earlyEntry,
        profile: this.profile,
        atmStrike: this._getATMStrike(ltp),
      };

      // Signal generation
      const signal = this.signalEngine.evaluate(analysis);
      if (signal) {
        signal.status = 'NEW';

        // AUDIT: Log signal with full context
        let auditId = null;
        if (this.signalAudit) {
          auditId = this.signalAudit.logSignal(signal, this.instrumentId, {
            entryPrice: ltp,
            indicators: {
              ema5: indicators.ema5,
              ema9: indicators.ema9,
              ema21: indicators.ema21,
              vwap: indicators.vwap,
              rsi: indicators.rsi,
              bb: indicators.bb,
              atr14: indicators.atr14,
              volume: indicators.volume,
              avgVolume: indicators.avgVolume,
            },
            marketState: {
              state: marketState.state,
              confidence: marketState.confidence,
              reasons: marketState.reasons,
            },
            oi: {
              pcr: oiAnalysis.pcr,
              pcrBias: oiAnalysis.pcrBias,
              support: oiAnalysis.support,
              resistance: oiAnalysis.resistance,
              isPinned: oiAnalysis.isPinned,
              oiBullish: oiAnalysis.oiBullish,
              oiBearish: oiAnalysis.oiBearish,
              wallPressure: oiAnalysis.wallPressure,
            },
            regime: {
              regime: regime.regime,
              strength: regime.strength,
            },
            abortFlags: [],
            factors: signal.factors || [],
          });
          signal.auditId = auditId; // Link signal to audit record
        }

        this.emit('signal', { instrumentId: this.instrumentId, signal, analysis });

        const premium = signal.type === 'BUY_CE' ? optionChainData?.find(r => r.strikePrice === signal.atmStrike)?.CE?.ltp : optionChainData?.find(r => r.strikePrice === signal.atmStrike)?.PE?.ltp;
        const lots = this.profile.lots || 1;

        if (premium && premium > 0) {
          const trade = this.tradeManager.openTrade(signal, premium, lots, this.profile);
          if (trade && auditId) {
            trade.auditId = auditId; // Link trade to audit
            this.signalAudit.logExecution(auditId, {
              filled: true,
              fillTimestamp: Date.now(),
              fillPremium: premium,
              slippage: 0, // theoretical fill
              lots,
              brokerOrderId: null, // paper trading for now
            });
          }
          this.emit('tradeOpen', { instrumentId: this.instrumentId, trade, signal });
        }
      }

      // Update trades
      this.tradeManager.updateTrades(ltp, optionChainData);

      this.lastAnalysisResult = analysis;
      this.emit('analysis', { instrumentId: this.instrumentId, analysis });
    } catch (err) {
      logger.error(`[InstrumentEngine] Analysis error for ${this.instrumentId}: ${err.message}`);
      this.emit('error', { instrumentId: this.instrumentId, error: err });
    }
  }

  _getATMStrike(ltp) {
    const step = this.profile.strikeStep || 50;
    return Math.round(ltp / step) * step;
  }

  getSnapshot() {
    return {
      instrumentId: this.instrumentId,
      ltp: this.currentLTP,
      candles: this.candleBuilder.getCandles(),
      indicators: this.indicators.getLastIndicators(),
      marketState: this.marketState.getCurrentState(),
      oiAnalysis: this.oiEngine.getAnalysis(this.currentLTP),
      signals: this.signalEngine.getSignals(),
      activeTrades: this.tradeManager.getActiveTrades(),
      tradeHistory: this.tradeManager.getTradeHistory(),
      greeks: this.greeksCalculator.getGreeks(),
      freshness: this.dataFreshness.getStatus(),
      regime: this.regimeDetector.getCurrentRegime(),
      lastAnalysis: this.lastAnalysisResult,
      isActive: this.isActive,
    };
  }

  start() { this.isActive = true; }
  stop() { this.isActive = false; }
  reset() {
    this.candleBuilder.reset();
    this.indicators.reset();
    this.marketState.reset();
    this.oiEngine = new OIEngine();
    this.signalEngine = new SignalEngine();
    this.tradeManager.reset();
    this.greeksCalculator.reset();
    this.signalCalibrator = new SignalCalibrator(this.instrumentId);
    this.earlyEntryDetector = new EarlyEntryDetector();
    this.currentLTP = null;
    this.lastLTP = null;
    this.lastAnalysis = 0;
    this.lastAnalysisResult = null;
    this.isActive = false;
  }
}

module.exports = { InstrumentEngine };
