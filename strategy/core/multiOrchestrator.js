// ============================================================
// MULTI ORCHESTRATOR
// Manages multiple instrument engines simultaneously
// Each instrument is fully independent — no shared state
// ============================================================

const { MarketDataService } = require('./marketDataService');
const { InstrumentEngine } = require('./instrumentEngine');
const { StockScanner } = require('../stockScanner');
const logger = require('../../logger');

class MultiOrchestrator {
  constructor(brokerConfig) {
    this.engines = new Map(); // instrumentId -> InstrumentEngine
    this.marketData = new MarketDataService(brokerConfig);
    this.stockScanner = null; // Set later
    this.externalBroadcast = null;
    this.authToken = null;
  }

  addInstrument(instrumentId, profile) {
    if (this.engines.has(instrumentId)) {
      logger.warn(`Instrument ${instrumentId} already added`);
      return;
    }

    const engine = new InstrumentEngine(instrumentId, profile, this.brokerConfig);

    // Wire callbacks
    engine.onSignal = (id, signal) => this.broadcast('SIGNAL', id, signal);
    engine.onTradeOpen = (id, trade) => this.broadcast('TRADE_OPEN', id, trade);
    engine.onTradeClose = (id, trade) => this.broadcast('TRADE_CLOSED', id, trade);
    engine.onUpdate = (id, update) => this.broadcast('ANALYSIS', id, update);
    engine.onSetupAbort = (id, abort) => this.broadcast('SETUP_ABORT', id, abort);

    this.engines.set(instrumentId, engine);

    // Load instrument master and start polling
    this.marketData.loadInstrumentMaster(instrumentId).then(() => {
      if (this.authToken) {
        this.marketData.startPolling(instrumentId, this.authToken, (type, ...args) => {
          const eng = this.engines.get(instrumentId);
          if (!eng) return;
          if (type === 'TICK') eng.onTick(...args);
          if (type === 'CHAIN') eng.onOptionChain(...args);
        });
      }
    }).catch(err => {
      logger.error(`Failed to load instrument master for ${instrumentId}: ${err.message}`);
    });

    logger.info(`Added instrument: ${instrumentId} (${profile.name})`);
  }

  addStock(stockName) {
    const stockId = `STOCK_${stockName}`;
    if (this.engines.has(stockId)) return;

    const profiles = require('../dna/instrumentProfiles');
    const profile = { ...profiles.STOCK_OPTION_TEMPLATE };
    profile.name = stockName;

    this.marketData.loadInstrumentMaster(stockId, stockName).then(() => {
      const master = this.marketData.instruments.get(stockId);
      if (master?.tokenMap) {
        const first = Object.values(master.tokenMap)[0];
        if (first) {
          profile.lotSize = parseInt(first.lotsize) || 1;
          profile.strikeStep = this._inferStrikeStep(master.tokenMap);
        }
      }
      this.addInstrument(stockId, profile);
    }).catch(err => {
      logger.error(`Failed to load stock ${stockName}: ${err.message}`);
    });
  }

  removeInstrument(instrumentId) {
    this.marketData.stopPolling(instrumentId);
    this.engines.delete(instrumentId);
    logger.info(`Removed instrument: ${instrumentId}`);
  }

  getSnapshot(instrumentId) {
    const engine = this.engines.get(instrumentId);
    return engine ? engine.getSnapshot() : null;
  }

  getAllSnapshots() {
    const result = {};
    for (const [id, engine] of this.engines) {
      result[id] = engine.getSnapshot();
    }
    return result;
  }

  broadcast(type, instrumentId, data) {
    // NEVER suppress signals — always emit
    const msg = {
      type,
      instrument: instrumentId,
      data,
      timestamp: Date.now(),
    };

    // Backward compatibility: if instrument is SENSEX, add legacy fields
    if (instrumentId === 'SENSEX') {
      msg.lastSensex = data?.indicators?.price ?? data?.price ?? data?.ltp ?? null;
      msg.liveData = {
        sensex: msg.lastSensex,
        atmStrike: data?.atmStrike ?? null,
      };
    }

    if (this.externalBroadcast) {
      this.externalBroadcast(msg);
    }
  }

  setAuthToken(authToken) {
    this.authToken = authToken;
    this.marketData.setAuthToken(authToken);

    // Start polling for all existing engines
    for (const [instrumentId, engine] of this.engines) {
      this.marketData.startPolling(instrumentId, authToken, (type, ...args) => {
        const eng = this.engines.get(instrumentId);
        if (!eng) return;
        if (type === 'TICK') eng.onTick(...args);
        if (type === 'CHAIN') eng.onOptionChain(...args);
      });
    }
  }

  _inferStrikeStep(tokenMap) {
    const strikes = [];
    for (const info of Object.values(tokenMap || {})) {
      if (info.strike) strikes.push(info.strike);
    }
    const unique = [...new Set(strikes)].sort((a, b) => a - b);
    if (unique.length < 2) return 1;
    const diffs = [];
    for (let i = 1; i < unique.length; i++) {
      diffs.push(unique[i] - unique[i - 1]);
    }
    diffs.sort((a, b) => a - b);
    return diffs[0] || 1;
  }
}

module.exports = new MultiOrchestrator({});
module.exports.MultiOrchestrator = MultiOrchestrator;
