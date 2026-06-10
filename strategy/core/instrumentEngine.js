// ============================================================
// INSTRUMENT ENGINE v7 — Corrected for actual repo APIs
// Fixes all API mismatches identified from latest repo files:
// 1. TradeManager: require .TradeManager (class), new TradeManager() (no args)
// 2. candleBuilder: getCandles(tf), getCurrent(tf) require timeframe arg
// 3. VWAPCalculator: create instance, update in tick(), pass to indicators
// 4. indicators: calculateIndicators(candles5m, candles15m, candles30m, vwap)
// 5. Flatten nested indicator objects for downstream compatibility
// 6. marketState.update(indicators, candlesArray) — pass array, not object
// 7. abortEngine.check({ctx}) — single object, not positional args
// 8. earlyEntryDetector.check({ctx}) — .check() not .detect(), single object
// 9. RegimeDetector.classifyRegime() — STATIC method, call on class not instance
// 10. signalCalibrator.getSnapshot() — not .getCalibration()
// 11. Store this.lastIndicators for getSnapshot()
// 12. dataFreshness.getStaleReport() — not .getStatus()
// 13. marketState.getState() — not .getCurrentState()
// 14. greeksCalculator has no .update() or .getGreeks() — wrap in try-catch
// ============================================================

const EventEmitter = require('events');
const logger = require('../../logger');

const CandleBuilder = require('../candleBuilder').CandleBuilder;
const indicators = require('../indicators');
const { VWAPCalculator } = require('../indicators');
const MarketStateEngine = require('../marketStateEngine').MarketStateEngineClass;
const OIEngine = require('../oiEngine').OIEngine;
const SignalEngine = require('../signalEngine').SignalEngine;
const TradeManager = require('../tradeManager').TradeManager;
const AbortEngine = require('../abortEngine');
const DataFreshness = require('../dataFreshness');
const GreeksCalculator = require('../greeksCalculator');
const SignalCalibrator = require('../signalCalibrator');
const EarlyEntryDetector = require('../earlyEntryDetector').EarlyEntryDetector;
const RegimeDetector = require('../regimeDetector');

class InstrumentEngine extends EventEmitter {
  constructor(instrumentId, profile, config = {}) {
    super();
    this.instrumentId = instrumentId;
    this.profile = profile;
    this.config = config;
    this.isActive = false;

    this.candleBuilder = new CandleBuilder();
    this.vwap = new VWAPCalculator();           // Create VWAP instance here
    this.indicators = indicators;                 // module object (functions)
    this.marketState = new MarketStateEngine();
    this.oiEngine = new OIEngine();
    this.signalEngine = new SignalEngine();
    this.tradeManager = new TradeManager();       // No args — repo constructor takes none
    this.abortEngine = new AbortEngine();
    this.dataFreshness = new DataFreshness();
    this.greeksCalculator = new GreeksCalculator();
    this.signalCalibrator = new SignalCalibrator();
    this.earlyEntryDetector = new EarlyEntryDetector();
    this.regimeDetector = new RegimeDetector();

    this.currentLTP = null;
    this.lastLTP = null;
    this.lastAnalysis = 0;
    this.analysisInterval = 5000;
    this.lastAnalysisResult = null;
    this.lastIndicators = null;                   // Store for getSnapshot()
    this.lastRegime = null;                       // Store for getSnapshot()

    // Audit framework (injected from MultiOrchestrator)
    this.signalAudit = null;

    this._bindEvents();
  }

  setSignalAudit(audit) {
    this.signalAudit = audit;
  }

  _bindEvents() {
    // TradeManager now extends EventEmitter (see tradeManager.js v7)
    this.tradeManager.on('tradeOpened', (trade) => {
      this.emit('tradeOpened', { instrumentId: this.instrumentId, trade });
      if (this.signalAudit && trade.signalId) {
        this.signalEngine.activateSignal(this.instrumentId, trade.signalId);
      }
    });
    this.tradeManager.on('tradeClosed', (trade) => {
      this.emit('tradeClosed', { instrumentId: this.instrumentId, trade });
      if (this.signalAudit && trade.signalId) {
        this.signalAudit.updateOutcome(trade.auditId, {
          status: trade.pnl >= 0 ? 'WIN' : 'LOSS',
          exitTimestamp: trade.closedAt,
          exitPrice: trade.currentPrice,
          exitPremium: trade.currentPremium,
          exitReason: trade.exitReason,
          pnl: trade.pnl,
          durationMs: trade.durationMs,
          maxProfit: trade.maxProfit,
          maxDrawdown: trade.maxDrawdown,
          actualRR: trade.targetPts > 0 ? trade.pnl / (trade.slPts * trade.lots) : 0,
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
    this.dataFreshness.update('ltp', timestamp, { ltp });

    this.candleBuilder.tick(ltp, timestamp);

    // FIX: Update VWAP with current forming 5m candle
    const current5m = this.candleBuilder.getCurrent(5);
    if (current5m) {
      this.vwap.update(current5m);
    }

    this.emit('tick', { instrumentId: this.instrumentId, ltp, timestamp });

    if (optionChainData) {
      this.oiEngine.update(optionChainData);
      this.dataFreshness.update('oi', timestamp, { chainLength: optionChainData.length });
      this.emit('oiUpdate', { instrumentId: this.instrumentId, oiData: this.oiEngine.getAnalysis(ltp) });
    }

    if (marketData) {
      // Repo greeksCalculator has no .update() — wrap in try-catch
      try {
        if (typeof this.greeksCalculator.update === 'function') {
          this.greeksCalculator.update(marketData);
        }
      } catch (e) {
        // Silently ignore — greeksCalculator repo version has no update()
      }
      this.dataFreshness.update('greeks', timestamp, marketData);
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
      // FIX: Get candles by timeframe (candleBuilder requires tf arg)
      const candles5m = this.candleBuilder.getCandles(5);
      const candles15m = this.candleBuilder.getCandles(15);
      const candles30m = this.candleBuilder.getCandles(30);
      const current5mRaw = this.candleBuilder.getCurrent(5);
      const prev5mRaw = candles5m.length > 0 ? candles5m[candles5m.length - 1] : null;

      if (!current5mRaw) return;

      // FIX: Analyze candles — add bodyRatio, bullish, bearish, etc.
      const current5m = this.indicators.analyzeCandle(current5mRaw);
      const prev5m = prev5mRaw ? this.indicators.analyzeCandle(prev5mRaw) : null;

      // Build candles object expected by signalEngine (it expects .current5m property)
      const candles = {
        candles5m,
        candles15m,
        candles30m,
        current5m,
        prev5m,
      };

      // FIX: Calculate indicators with correct signature (arrays + vwap instance)
      const indicatorData = this.indicators.calculateIndicators(candles5m, candles15m, candles30m, this.vwap);
      if (!indicatorData) {
        logger.warn(`[InstrumentEngine] ${this.instrumentId} indicators returned null (not enough candles)`);
        return;
      }

      // FIX: Flatten nested objects for downstream compatibility
      // indicators.js returns: vwap:{vwap,upper1...}, volume:{current,avg20}
      // Downstream expects: vwap (scalar), volume (scalar), avgVolume (scalar)
      const indicators = {
        ...indicatorData,
        ...indicatorData.bias,           // htfBullish, htfBearish, bullishEMA, bearishEMA, aboveVWAP, belowVWAP
        ...indicatorData.momentum,       // bullMomentum, bearMomentum
        ...indicatorData.breakout,       // priceAboveBB, priceBelowBB
        ...indicatorData.candle,         // last, prev1, prev2 (analyzed candles)
        vwap: indicatorData.vwapValue || (indicatorData.vwap?.vwap || 0),
        volume: indicatorData.volume?.current || 0,
        avgVolume: indicatorData.volume?.avg20 || 0,
        atrMA20: indicatorData.atr14_MA20 || 0,   // alias for regimeDetector
      };
      this.lastIndicators = indicators;

      // FIX: marketState.update() expects candles ARRAY, not object
      const marketState = this.marketState.update(indicators, candles5m);

      const oiAnalysis = this.oiEngine.getAnalysis(ltp);

      // FIX: RegimeDetector.classifyRegime is STATIC — call on class, not instance
      const regime = RegimeDetector.classifyRegime(indicators.atr14, indicators.atrMA20 || 0, null);
      this.lastRegime = regime;

      // Repo greeksCalculator has no .getGreeks() — wrap in try-catch
      let greeks = null;
      try {
        if (typeof this.greeksCalculator.getGreeks === 'function') {
          greeks = this.greeksCalculator.getGreeks();
        }
      } catch (e) {
        greeks = null;
      }

      // FIX: dataFreshness.getStaleReport() not .getStatus()
      const freshness = this.dataFreshness.getStaleReport(Date.now());

      // FIX: signalCalibrator.getSnapshot() not .getCalibration()
      const calibrator = this.signalCalibrator.getSnapshot();

      // FIX: earlyEntryDetector.check({ctx}) not .detect(positional args)
      const earlyEntry = this.earlyEntryDetector.check({
        indicators,
        marketState,
        oiAnalysis,
        price: ltp,
        timestamp,
      });

      // FIX: abortEngine.check({ctx}) not positional args
      const abortResult = this.abortEngine.check({
        price: ltp,
        indicators,
        marketState,
        oiAnalysis,
        regime,
        signal: null,
        timestamp,
      });
      // abortResult is { id, reasons, ... } or null
      if (abortResult && abortResult.reasons && abortResult.reasons.length > 0) {
        this.emit('abort', { instrumentId: this.instrumentId, reasons: abortResult.reasons });
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
          signal.auditId = auditId;
        }

        this.emit('signal', { instrumentId: this.instrumentId, signal, analysis });

        const premium = signal.type === 'BUY_CE'
          ? optionChainData?.find(r => r.strikePrice === signal.atmStrike)?.CE?.ltp
          : optionChainData?.find(r => r.strikePrice === signal.atmStrike)?.PE?.ltp;
        const lots = this.profile.lots || 1;

        if (premium && premium > 0) {
          const trade = this.tradeManager.openTrade(signal, premium, lots, this.profile);
          if (trade && auditId) {
            trade.auditId = auditId;
            this.signalAudit.logExecution(auditId, {
              filled: true,
              fillTimestamp: Date.now(),
              fillPremium: premium,
              slippage: 0,
              lots,
              brokerOrderId: null,
            });
          }
          this.emit('tradeOpen', { instrumentId: this.instrumentId, trade, signal });
        }
      }

      // Update trades
      // tradeManager.updateTrade expects (premium, price) not (ltp, optionChainData)
      // We need the ATM premium for the active trade's option type
      const activeTrade = this.tradeManager.getActiveTrade();
      if (activeTrade && optionChainData) {
        const atmStrike = this._getATMStrike(ltp);
        const atmRow = optionChainData.find(r => r.strikePrice === atmStrike);
        if (atmRow) {
          const premium = activeTrade.type === 'BUY_CE' ? atmRow.CE?.ltp : atmRow.PE?.ltp;
          if (premium !== undefined) {
            this.tradeManager.updateTrade(premium, ltp);
          }
        }
      }

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
      candles: {
        '5m': this.candleBuilder.getCandles(5),
        '15m': this.candleBuilder.getCandles(15),
        '30m': this.candleBuilder.getCandles(30),
        current5m: this.candleBuilder.getCurrent(5),
      },
      indicators: this.lastIndicators,
      marketState: this.marketState.getState(),        // FIX: .getState() not .getCurrentState()
      oiAnalysis: this.oiEngine.getAnalysis(this.currentLTP),
      signals: this.signalEngine.getSignals(),
      activeTrades: this.tradeManager.getActiveTrade(),
      tradeHistory: this.tradeManager.tradeHistory,
      greeks: this.lastRegime,                          // Placeholder — repo greeks has no getGreeks()
      freshness: this.dataFreshness.getStaleReport(Date.now()),
      regime: this.lastRegime,
      lastAnalysis: this.lastAnalysisResult,
      isActive: this.isActive,
    };
  }

  start() { this.isActive = true; }
  stop() { this.isActive = false; }
  reset() {
    this.candleBuilder.reset();
    this.vwap = new VWAPCalculator();
    this.indicators = require('../indicators');
    this.marketState.reset();
    this.oiEngine = new OIEngine();
    this.signalEngine = new SignalEngine();
    this.tradeManager.reset();
    this.greeksCalculator = new GreeksCalculator();
    this.signalCalibrator = new SignalCalibrator();
    this.earlyEntryDetector = new EarlyEntryDetector();
    this.regimeDetector = new RegimeDetector();
    this.currentLTP = null;
    this.lastLTP = null;
    this.lastAnalysis = 0;
    this.lastAnalysisResult = null;
    this.lastIndicators = null;
    this.lastRegime = null;
    this.isActive = false;
  }
}

module.exports = { InstrumentEngine };
