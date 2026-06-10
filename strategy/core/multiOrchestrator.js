// ============================================================
// MULTI ORCHESTRATOR v7 — Broker Adapter + Audit Integration
// Changes from v6:
// 1. Accepts broker adapter and audit framework via constructor
// 2. No hardcoded Angel One references
// 3. Injects audit into each InstrumentEngine
// 4. WebSocket throttling (only broadcast on significant change)
// 5. Graceful per-instrument failure isolation
// ============================================================

const EventEmitter = require('events');
const InstrumentEngine = require('./instrumentEngine').InstrumentEngine;
const MarketDataService = require('./marketDataService').MarketDataService;
const logger = require('../../logger');

class MultiOrchestrator extends EventEmitter {
  constructor(brokerAdapter, auditFramework, options = {}) {
    super();
    this.broker = brokerAdapter;
    this.audit = auditFramework;
    this.options = {
      ltpInterval: options.ltpInterval || 2000,
      chainInterval: options.chainInterval || 5000,
      wsThrottleMs: options.wsThrottleMs || 5000,
      ...options,
    };

    this.marketDataService = new MarketDataService(brokerAdapter, {
      ltpInterval: this.options.ltpInterval,
      chainInterval: this.options.chainInterval,
      useRedis: options.useRedis || false,
      redisClient: options.redisClient || null,
    });

    this.engines = new Map();
    this.profiles = new Map();
    this.pollingTimers = new Map();
    this.isRunning = false;

    // WebSocket throttling state
    this._lastBroadcast = new Map();
    this._lastBroadcastData = new Map();
  }

  async initialize() {
    await this.marketDataService.initialize();
    logger.info('[MultiOrchestrator] Initialized');
  }

  addInstrument(instrumentId, profile) {
    if (this.engines.has(instrumentId)) {
      logger.warn(`[MultiOrchestrator] Instrument ${instrumentId} already added`);
      return;
    }

    const engine = new InstrumentEngine(instrumentId, profile, this.options);

    // Inject audit framework
    if (this.audit) {
      engine.setSignalAudit(this.audit);
    }

    // Bind engine events
    engine.on('signal', (data) => {
      this.emit('signal', data);
      this._throttledBroadcast(instrumentId, 'SIGNAL', data);
    });
    engine.on('tradeOpen', (data) => {
      this.emit('tradeOpen', data);
      this._throttledBroadcast(instrumentId, 'TRADE_OPEN', data);
    });
    engine.on('tradeClosed', (data) => {
      this.emit('tradeClosed', data);
      this._throttledBroadcast(instrumentId, 'TRADE_CLOSED', data);
    });
    engine.on('tradeUpdated', (data) => {
      this.emit('tradeUpdated', data);
    });
    engine.on('trailingStopActivated', (data) => {
      this.emit('trailingStopActivated', data);
    });
    engine.on('abort', (data) => {
      this.emit('abort', data);
    });
    engine.on('error', (data) => {
      logger.error(`[MultiOrchestrator] Engine error for ${data.instrumentId}: ${data.error?.message || data.error}`);
      this.emit('engineError', data);
    });

    this.engines.set(instrumentId, engine);
    this.profiles.set(instrumentId, profile);
    logger.info(`[MultiOrchestrator] Added instrument: ${instrumentId}`);
  }

  removeInstrument(instrumentId) {
    const engine = this.engines.get(instrumentId);
    if (engine) {
      engine.stop();
      this.marketDataService.stopPolling(instrumentId);
      this.engines.delete(instrumentId);
      this.profiles.delete(instrumentId);
      logger.info(`[MultiOrchestrator] Removed instrument: ${instrumentId}`);
    }
  }

  startInstrument(instrumentId) {
    const engine = this.engines.get(instrumentId);
    const profile = this.profiles.get(instrumentId);
    if (!engine || !profile) {
      logger.error(`[MultiOrchestrator] Cannot start unknown instrument: ${instrumentId}`);
      return;
    }

    engine.start();

    // Start polling with error isolation
    this.marketDataService.startPolling(instrumentId, {
      onLTP: (ltpData) => {
        try {
          engine.tick(ltpData.ltp, ltpData.timestamp);
          this._throttledBroadcast(instrumentId, 'TICK', { instrumentId, ltp: ltpData.ltp, timestamp: ltpData.timestamp });
        } catch (err) {
          logger.error(`[MultiOrchestrator] LTP tick error for ${instrumentId}: ${err.message}`);
        }
      },
      onChain: (chainData) => {
        try {
          const ltp = this.marketDataService.lastLTP.get(instrumentId);
          if (ltp) {
            engine.tick(ltp, Date.now(), chainData.chainData, chainData.premiums);
          }
        } catch (err) {
          logger.error(`[MultiOrchestrator] Chain tick error for ${instrumentId}: ${err.message}`);
        }
      },
      onError: (source, err) => {
        logger.error(`[MultiOrchestrator] ${source} error for ${instrumentId}: ${err.message}`);
        this.emit('dataError', { instrumentId, source, error: err });
      },
    }, profile);

    logger.info(`[MultiOrchestrator] Started instrument: ${instrumentId}`);
  }

  stopInstrument(instrumentId) {
    const engine = this.engines.get(instrumentId);
    if (engine) {
      engine.stop();
      this.marketDataService.stopPolling(instrumentId);
      logger.info(`[MultiOrchestrator] Stopped instrument: ${instrumentId}`);
    }
  }

  startAll() {
    this.isRunning = true;
    for (const [instrumentId] of this.engines) {
      this.startInstrument(instrumentId);
    }
    logger.info('[MultiOrchestrator] All instruments started');
  }

  stopAll() {
    this.isRunning = false;
    for (const [instrumentId] of this.engines) {
      this.stopInstrument(instrumentId);
    }
    logger.info('[MultiOrchestrator] All instruments stopped');
  }

  getSnapshot(instrumentId) {
    const engine = this.engines.get(instrumentId);
    return engine ? engine.getSnapshot() : null;
  }

  getAllSnapshots() {
    const snapshots = {};
    for (const [instrumentId, engine] of this.engines) {
      snapshots[instrumentId] = engine.getSnapshot();
    }
    return snapshots;
  }

  // ── WEBSOCKET THROTTLING ────────────────────────────────────
  _throttledBroadcast(instrumentId, type, data) {
    const now = Date.now();
    const key = `${instrumentId}:${type}`;
    const lastTime = this._lastBroadcast.get(key) || 0;
    const lastData = this._lastBroadcastData.get(key);

    // Always broadcast SIGNAL and TRADE events immediately
    if (type === 'SIGNAL' || type === 'TRADE_OPEN' || type === 'TRADE_CLOSED') {
      this._doBroadcast(instrumentId, type, data);
      this._lastBroadcast.set(key, now);
      this._lastBroadcastData.set(key, JSON.stringify(data));
      return;
    }

    // Throttle TICK broadcasts: only if > 5s since last OR value changed > 0.1%
    if (now - lastTime < this.options.wsThrottleMs) {
      // Check if value changed significantly
      if (type === 'TICK' && lastData) {
        const last = JSON.parse(lastData);
        if (last.ltp && data.ltp) {
          const change = Math.abs(data.ltp - last.ltp) / last.ltp;
          if (change < 0.001) return; // < 0.1% change, skip
        }
      }
      return;
    }

    this._doBroadcast(instrumentId, type, data);
    this._lastBroadcast.set(key, now);
    this._lastBroadcastData.set(key, JSON.stringify(data));
  }

  _doBroadcast(instrumentId, type, data) {
    this.emit('broadcast', { instrumentId, type, data, timestamp: Date.now() });
  }

  async shutdown() {
    this.stopAll();
    await this.marketDataService.shutdown();
    logger.info('[MultiOrchestrator] Shutdown complete');
  }
}

module.exports = { MultiOrchestrator };
