// ============================================================
// MARKET DATA SERVICE v7 — Broker-Agnostic
// Changes from v6:
// 1. All Angel-specific code removed (moved to AngelAdapter)
// 2. Accepts BrokerAdapter via constructor injection
// 3. Keeps polling logic, rate limiting, caching, error handling
// 4. Added Redis cache integration (optional, fallback to memory)
// ============================================================

const logger = require('../../logger');

class MarketDataService {
  constructor(brokerAdapter, options = {}) {
    this.broker = brokerAdapter;
    this.options = {
      ltpInterval: options.ltpInterval || 2000,
      chainInterval: options.chainInterval || 5000,
      useRedis: options.useRedis || false,
      redisClient: options.redisClient || null,
      ...options,
    };

    this.tokenMap = {};
    this.instrumentMaster = null;
    this.masterLoadTime = 0;
    this._masterLoadPromise = null;

    this.pollingIntervals = new Map();
    this.lastLTP = new Map();
    this.lastChainData = new Map();
    this.lastChainTime = new Map();

    this._isRunning = false;
  }

  async initialize() {
    await this.broker.authenticate();
    this.broker.startTokenRefreshLoop?.();
    await this._loadInstrumentMaster();
    logger.info('[MarketDataService] Initialized with broker: ' + this.broker.name);
  }

  async _loadInstrumentMaster() {
    if (this._masterLoadPromise) return this._masterLoadPromise;
    this._masterLoadPromise = this._doLoadMaster();
    try {
      return await this._masterLoadPromise;
    } finally {
      this._masterLoadPromise = null;
    }
  }
	
  _buildAllTokenMaps() {
    for (const instrumentId of ['NIFTY', 'BANKNIFTY', 'SENSEX', 'BANKEX']) {
        this.tokenMap[instrumentId] = this._buildTokenMap(instrumentId);
    }
}

_buildTokenMap(instrumentId) {
    const map = {};
    if (!this.instrumentMaster) return map;
    for (const item of this.instrumentMaster) {
        const name = item.name || item.symbol || item.tradingsymbol || '';
        if (name.includes(instrumentId)) {
            map[item.token] = {
                symbol: item.symbol || item.tradingsymbol,
                name: item.name,
                token: item.token,
                exch_seg: item.exch_seg || item.exchange,
                expiry: item.expiry,
                strike: parseFloat(item.strike) || 0,
                lotsize: parseInt(item.lotsize) || 0,
                instrumenttype: item.instrumenttype,
                tick_size: parseFloat(item.tick_size) || 0,
            };
        }
    }
    return map;
}


  async _doLoadMaster() {
    try {
      this.instrumentMaster = await this.broker.getInstrumentMaster();
      this.masterLoadTime = Date.now();
      logger.info(`[MarketDataService] Loaded ${this.instrumentMaster.length} instruments from ${this.broker.name}`);
      return this.instrumentMaster;
    } catch (err) {
      logger.error(`[MarketDataService] Failed to load instrument master: ${err.message}`);
      throw err;
    }
  }

  getTokenMap() {
    return this.tokenMap;
  }

  setTokenMap(map) {
    this.tokenMap = map || {};
  }

  getInstrumentMaster() {
    return this.instrumentMaster;
  }

  // ── REDIS CACHE HELPERS ─────────────────────────────────────
  async _cacheGet(key) {
    if (!this.options.useRedis || !this.options.redisClient) return null;
    try {
      const val = await this.options.redisClient.get(key);
      return val ? JSON.parse(val) : null;
    } catch (err) {
      return null;
    }
  }

  async _cacheSet(key, value, ttlSeconds) {
    if (!this.options.useRedis || !this.options.redisClient) return;
    try {
      await this.options.redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch (err) {
      logger.warn(`[MarketDataService] Redis cache set failed: ${err.message}`);
    }
  }

  // ── LTP FETCH ───────────────────────────────────────────────
  async fetchIndexLTP(instrumentId, exchange, token) {
    const cacheKey = `md:${instrumentId}:ltp`;

    // Try Redis cache first
    const cached = await this._cacheGet(cacheKey);
    if (cached && Date.now() - cached.timestamp < 8000) { // 8s stale tolerance
      return cached;
    }

    try {
      const result = await this.broker.getSpotLTP(instrumentId, exchange, token);
      this.lastLTP.set(instrumentId, result.ltp);

      // Cache in Redis
      await this._cacheSet(cacheKey, result, 10);

      return result;
    } catch (err) {
      logger.error(`[MarketDataService] LTP fetch failed for ${instrumentId}: ${err.message}`);
      // Fallback to last known
      const last = this.lastLTP.get(instrumentId);
      if (last) {
        return { ltp: last, timestamp: Date.now(), stale: true };
      }
      throw err;
    }
  }

  // ── OPTION CHAIN FETCH ──────────────────────────────────────
  async fetchOptionChain(instrumentId, spotPrice, expiry, profile) {
    const cacheKey = `oc:${instrumentId}:${expiry}`;
	const result = await this.broker.getOptionChain(
    instrumentId, spotPrice, expiry, 
    this.tokenMap[instrumentId] || {},  // ← pass specific instrument's map
    profile
	);
    // Try Redis cache
    const cached = await this._cacheGet(cacheKey);
    if (cached && Date.now() - cached.timestamp < 30000) { // 30s stale tolerance
      return cached;
    }

    try {
      const result = await this.broker.getOptionChain(instrumentId, spotPrice, expiry, this.tokenMap, profile);
      this.lastChainData.set(instrumentId, result.chainData);
      this.lastChainTime.set(instrumentId, Date.now());

      // Cache in Redis
      await this._cacheSet(cacheKey, result, 30);

      return result;
    } catch (err) {
      logger.error(`[MarketDataService] Chain fetch failed for ${instrumentId}: ${err.message}`);
      // Fallback to last known
      const lastData = this.lastChainData.get(instrumentId);
      const lastTime = this.lastChainTime.get(instrumentId);
      if (lastData && lastTime && Date.now() - lastTime < 120000) {
        return { chainData: lastData, premiums: null, tokens: [], stale: true, timestamp: lastTime };
      }
      throw err;
    }
  }

  // ── POLLING CONTROL ─────────────────────────────────────────
  startPolling(instrumentId, callbacks, profile) {
    if (this.pollingIntervals.has(instrumentId)) {
      logger.warn(`[MarketDataService] Polling already active for ${instrumentId}`);
      return;
    }

    const { exchange, token } = profile;
    const ltpInterval = this.options.ltpInterval;
    const chainInterval = this.options.chainInterval;

    // LTP polling
    const ltpTimer = setInterval(async () => {
      try {
        const ltpData = await this.fetchIndexLTP(instrumentId, exchange, token);
        if (callbacks.onLTP) callbacks.onLTP(ltpData);
      } catch (err) {
        if (callbacks.onError) callbacks.onError('ltp', err);
      }
    }, ltpInterval);

    // Chain polling
    const chainTimer = setInterval(async () => {
      try {
        const lastLTP = this.lastLTP.get(instrumentId);
        if (!lastLTP) return;

        const expiry = profile.expiry || this._getNearestExpiry(instrumentId);
        const chainData = await this.fetchOptionChain(instrumentId, lastLTP, expiry, profile);
        if (callbacks.onChain) callbacks.onChain(chainData);
      } catch (err) {
        if (callbacks.onError) callbacks.onError('chain', err);
      }
    }, chainInterval);

    this.pollingIntervals.set(instrumentId, { ltpTimer, chainTimer });
    logger.info(`[MarketDataService] Started polling for ${instrumentId}`);
  }

  stopPolling(instrumentId) {
    const timers = this.pollingIntervals.get(instrumentId);
    if (timers) {
      clearInterval(timers.ltpTimer);
      clearInterval(timers.chainTimer);
      this.pollingIntervals.delete(instrumentId);
      logger.info(`[MarketDataService] Stopped polling for ${instrumentId}`);
    }
  }

  stopAllPolling() {
    for (const [instrumentId, timers] of this.pollingIntervals) {
      clearInterval(timers.ltpTimer);
      clearInterval(timers.chainTimer);
    }
    this.pollingIntervals.clear();
    logger.info('[MarketDataService] All polling stopped');
  }

  _getNearestExpiry(instrumentId) {
    // This should be provided by the instrument profile or expiry calculator
    // Fallback to Thursday of current week
    const now = new Date();
    const day = now.getDay();
    const diff = 4 - day; // Thursday = 4
    const thursday = new Date(now);
    thursday.setDate(now.getDate() + diff);
    thursday.setHours(15, 30, 0, 0);
    return thursday.toISOString().split('T')[0];
  }

  async shutdown() {
    this.stopAllPolling();
    this.broker.stopTokenRefreshLoop?.();
    logger.info('[MarketDataService] Shutdown complete');
  }
}

module.exports = { MarketDataService };
