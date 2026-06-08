// ============================================================
// MULTI-ORCHESTRATOR (v3 — Phase 2)
// CRITICAL FIXES:
// 1. Pass full instrument profile to marketDataService.loadInstrumentMaster()
// 2. Add setAuthToken() proxy for server.js compatibility
// 3. Polling callback args match engine method signatures
// ============================================================

const { InstrumentEngine } = require('./instrumentEngine');
const { MarketDataService } = require('./marketDataService');
const { StockScanner } = require('../stockScanner');
const logger = require('../../logger');

class MultiOrchestrator {
  constructor() {
    this.engines = new Map();
    this.marketData = new MarketDataService();
    this.stockScanner = new StockScanner(this.marketData, this);
    this.externalBroadcast = null;
  }

  setAuthToken(authToken, refreshToken = null) {
    if (this.marketData && typeof this.marketData.setAuthToken === 'function') {
      this.marketData.setAuthToken(authToken, refreshToken);
      logger.info('Auth token propagated to market data service');
    }
  }

  addInstrument(instrumentId, profile) {
    if (this.engines.has(instrumentId)) {
      logger.warn(`Instrument ${instrumentId} already added, skipping`);
      return;
    }

    const engine = new InstrumentEngine(instrumentId, profile);

    engine.onSignal = (id, signal) => {
      this.broadcast('SIGNAL', id, signal);
    };
    engine.onTradeOpen = (id, trade) => {
      this.broadcast('TRADE_OPEN', id, trade);
    };
    engine.onTradeClose = (id, trade) => {
      this.broadcast('TRADE_CLOSED', id, trade);
    };
    engine.onUpdate = (id, update) => {
      this.broadcast('ANALYSIS', id, update);
    };
    engine.onSetupAbort = (id, abort) => {
      this.broadcast('ABORT', id, abort);
    };

    this.engines.set(instrumentId, engine);

    this.marketData.loadInstrumentMaster(instrumentId, null, profile)
      .then(() => {
        logger.info(`Added instrument: ${instrumentId} (${profile.name})`);
      })
      .catch(err => {
        logger.error(`Failed to load instrument master for ${instrumentId}: ${err.message}`);
      });

    // FIX: callback receives (type, ...args) where args match engine method signatures
    // TICK: (type, ltp, timestamp) -> engine.onTick(ltp, timestamp)
    // CHAIN: (type, chainData, premiums, timestamp) -> engine.onOptionChain(chainData, premiums, timestamp)
    this.marketData.startPolling(instrumentId, (type, ...args) => {
      const eng = this.engines.get(instrumentId);
      if (!eng) return;
      if (type === 'TICK') eng.onTick(...args);
      if (type === 'CHAIN') eng.onOptionChain(...args);
    });

    logger.info(`✅ Added instrument: ${instrumentId}`);
  }

  addStock(stockName) {
    const stockId = `STOCK_${stockName}`;
    if (this.engines.has(stockId)) return;

    const STOCK_OPTION_TEMPLATE = {
      market:'NSE', indexExchange:'NSE', optionExchange:'NFO',
      instrumenttype: 'OPTSTK',
      lotSize: null,
      strikeStep: null,
      tickSize:0.05,
      expiryType: 'monthly', expiryDayOfWeek: 2,
      atrMultiplier:{target:0.6, sl:0.5},
      minPremium:10, maxPremium:500,
      optimalWindows:['10:00-11:30','14:00-15:00'],
      gammaRiskExpiryHours:24,
      ivPercentileMax:75,
      maxSignalsDay:3, maxTradesDay:2, cooldownMs:300000
    };

    const profile = { ...STOCK_OPTION_TEMPLATE, name: stockName };

    this.marketData.loadInstrumentMaster(stockId, stockName, profile)
      .then(() => {
        const master = this.marketData.instruments.get(stockId);
        if (master?.tokenMap) {
          const first = Object.values(master.tokenMap)[0];
          if (first) {
            profile.lotSize = parseInt(first.lotsize) || 1;
            profile.strikeStep = this._inferStrikeStep(master.tokenMap);
          }
        }
        this.addInstrument(stockId, profile);
      })
      .catch(err => {
        logger.error(`Failed to load stock ${stockName}: ${err.message}`);
      });
  }

  removeInstrument(instrumentId) {
    const engine = this.engines.get(instrumentId);
    if (engine) {
      this.marketData.stopPolling(instrumentId);
      this.engines.delete(instrumentId);
      this.marketData.instruments.delete(instrumentId);
      logger.info(`Removed instrument: ${instrumentId}`);
    }
  }

  getSnapshot(instrumentId) {
    return this.engines.get(instrumentId)?.getSnapshot();
  }

  getAllSnapshots() {
    const result = {};
    for (const [id, engine] of this.engines) {
      result[id] = engine.getSnapshot();
    }
    return result;
  }

  broadcast(type, instrumentId, data) {
    const engine = this.engines.get(instrumentId);
    const msg = {
      type,
      instrument: instrumentId,
      market: engine?.profile?.market || 'NSE',
      data,
      serverTime: Date.now()
    };
    if (this.externalBroadcast) {
      try { this.externalBroadcast(msg); } catch (err) { logger.error('Broadcast error:', err.message); }
    }
  }

  _inferStrikeStep(tokenMap) {
    const strikes = [...new Set(Object.values(tokenMap).map(i => parseFloat(i.strike)).filter(Number.isFinite))].sort((a, b) => a - b);
    if (strikes.length < 2) return 5;
    const diffs = [];
    for (let i = 1; i < strikes.length; i++) {
      const d = strikes[i] - strikes[i - 1];
      if (d > 0) diffs.push(d);
    }
    diffs.sort((a, b) => a - b);
    return diffs[0] || 5;
  }
}

module.exports = new MultiOrchestrator();
