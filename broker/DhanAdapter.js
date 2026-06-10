// ============================================================
// DHAN ADAPTER — Dhan API Implementation (Skeleton)
// Implements BrokerAdapter interface for Dhan Data API.
// Reference: https://dhanhq.co/docs/
// ============================================================

const axios = require('axios');
const { BrokerAdapter } = require('./BrokerAdapter');
const logger = require('../logger');

// Dhan API Endpoints (v2)
const DHAN_BASE_URL = 'https://api.dhan.co';
const DHAN_INSTRUMENT_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

class DhanAdapter extends BrokerAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'dhan';
    this.baseUrl = config.baseUrl || DHAN_BASE_URL;
    this.accessToken = config.accessToken || '';
    this.clientId = config.clientId || '';

    // Rate limiting: 25 req/s
    this.apiCallCount = 0;
    this.lastApiReset = Date.now();
    this._masterCache = null;
    this._masterCacheTime = 0;
    this._masterFetchPromise = null;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'access-token': this.accessToken,
    };
  }

  async rateLimit() {
    const now = Date.now();
    if (now - this.lastApiReset >= 1000) {
      this.apiCallCount = 0;
      this.lastApiReset = now;
    }
    while (this.apiCallCount >= 25) {
      await new Promise(r => setTimeout(r, 100));
      if (Date.now() - this.lastApiReset >= 1000) {
        this.apiCallCount = 0;
        this.lastApiReset = Date.now();
      }
    }
    this.apiCallCount++;
  }

  // ── AUTHENTICATION ─────────────────────────────────────────
  async authenticate() {
    // Dhan uses access token generated from DhanHQ dashboard.
    // No programmatic login. Token is long-lived (valid for months).
    if (!this.accessToken) {
      throw new Error('Dhan access token required. Generate at https://dhanhq.co/dashboard/');
    }
    // Validate token with a lightweight call
    try {
      await this.rateLimit();
      const resp = await axios.get(`${this.baseUrl}/v2/fundlimit`, {
        headers: this._headers(),
        timeout: 10000,
      });
      if (resp.status === 200) {
        this.authToken = this.accessToken;
        this.tokenExpiry = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days
        logger.info('[Dhan] Token validated successfully');
        return { token: this.accessToken, expiry: this.tokenExpiry };
      }
    } catch (err) {
      throw new Error(`Dhan token validation failed: ${err.message}`);
    }
    return { token: this.accessToken, expiry: this.tokenExpiry };
  }

  async refreshAuthToken() {
    // Dhan tokens don't require refresh. Re-authenticate if needed.
    return this.authenticate();
  }

  // ── MARKET DATA ────────────────────────────────────────────
  async getSpotLTP(instrumentId, exchange, securityId) {
    await this.rateLimit();
    // Dhan uses security_id (NSE: 13, BSE: 51, etc.)
    // For indices, use /v2/quotes/ltp with security_id
    const url = `${this.baseUrl}/v2/quotes/ltp`;
    const payload = {
      NSE: [securityId], // or BSE
    };
    const resp = await axios.post(url, payload, {
      headers: this._headers(),
      timeout: 10000,
    });

    // Dhan response: { data: [ { securityId, ltp, ... } ] }
    const data = resp.data?.data?.[0];
    if (!data) throw new Error('Empty LTP response from Dhan');

    return {
      ltp: parseFloat(data.ltp || data.lastTradedPrice || data.close),
      timestamp: Date.now(),
      raw: data,
    };
  }

  async getQuotes(exchangeTokens, mode = 'LTP') {
    await this.rateLimit();
    // Dhan /v2/quotes/ltp or /v2/quotes/ohlc
    const url = `${this.baseUrl}/v2/quotes/ltp`;
    const payload = {};
    for (const [exch, tokens] of Object.entries(exchangeTokens)) {
      payload[exch] = tokens;
    }
    const resp = await axios.post(url, payload, {
      headers: this._headers(),
      timeout: 15000,
    });
    return {
      fetched: resp.data?.data || [],
      timestamp: Date.now(),
    };
  }

  async getOptionChain(instrumentId, spotPrice, expiry, tokenMap, profile) {
    // Dhan has a dedicated option-chain endpoint: GET /v2/option-chain/{securityId}
    // This is a MAJOR advantage over Angel One (no batch quoting needed).
    const { strikeStep, optionExchange } = profile;
    const securityId = profile.dhanSecurityId; // Must be in profile

    if (!securityId) {
      throw new Error(`Dhan securityId required for ${instrumentId}`);
    }

    await this.rateLimit();
    const url = `${this.baseUrl}/v2/option-chain/${securityId}`;
    const resp = await axios.get(url, {
      headers: this._headers(),
      timeout: 15000,
    });

    // Dhan option chain response:
    // { data: [ { strikePrice, expiry, CE: { ltp, oi, volume, ... }, PE: { ... } }, ... ] }
    const chain = resp.data?.data || [];

    // Filter to relevant expiry and strikes
    const strikeCount = profile.instrumenttype === 'OPTSTK' ? 5 : 10;
    const minStrike = Math.round((spotPrice - strikeStep * strikeCount) / strikeStep) * strikeStep;
    const maxStrike = Math.round((spotPrice + strikeStep * strikeCount) / strikeStep) * strikeStep;

    const filtered = chain
      .filter(item => item.expiry === expiry && item.strikePrice >= minStrike && item.strikePrice <= maxStrike)
      .sort((a, b) => a.strikePrice - b.strikePrice);

    const chainData = filtered.map(item => ({
      strikePrice: item.strikePrice,
      CE: item.CE ? {
        ltp: parseFloat(item.CE.ltp) || 0,
        oi: parseInt(item.CE.oi) || 0,
        volume: parseInt(item.CE.volume) || 0,
        bid: parseFloat(item.CE.bid) || 0,
        ask: parseFloat(item.CE.ask) || 0,
        token: item.CE.securityId,
      } : null,
      PE: item.PE ? {
        ltp: parseFloat(item.PE.ltp) || 0,
        oi: parseInt(item.PE.oi) || 0,
        volume: parseInt(item.PE.volume) || 0,
        bid: parseFloat(item.PE.bid) || 0,
        ask: parseFloat(item.PE.ask) || 0,
        token: item.PE.securityId,
      } : null,
    }));

    const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
    const atmRow = chainData.find(r => r.strikePrice === atmStrike);
    const premiums = {
      ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
      pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
      atmStrike,
    };

    return { chainData, premiums, tokens: [] };
  }

  async getHistoricalData(instrumentId, exchange, securityId, interval, from, to) {
    await this.rateLimit();
    // Dhan historical: GET /v2/charts/historical/{securityId}/{interval}/{from}/{to}
    const url = `${this.baseUrl}/v2/charts/historical/${securityId}/${interval}/${from}/${to}`;
    const resp = await axios.get(url, {
      headers: this._headers(),
      timeout: 15000,
    });
    return resp.data;
  }

  // ── INSTRUMENT MASTER ───────────────────────────────────────
  async getInstrumentMaster() {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000;
    if (this._masterCache && (now - this._masterCacheTime) < cacheDuration) {
      return this._masterCache;
    }
    if (this._masterFetchPromise) return this._masterFetchPromise;

    this._masterFetchPromise = this._doFetchMaster();
    try {
      return await this._masterFetchPromise;
    } finally {
      this._masterFetchPromise = null;
    }
  }

  async _doFetchMaster() {
    const fs = require('fs');
    const path = require('path');
    const cacheFile = path.join(process.cwd(), 'data', 'dhan-scrip-master.csv');

    // Dhan provides a compact CSV master (~5MB vs Angel's 45MB JSON)
    // This is a major performance win.
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtime.getTime() < 12 * 60 * 60 * 1000) {
          const csv = fs.readFileSync(cacheFile, 'utf8');
          const parsed = this._parseCsvMaster(csv);
          this._masterCache = parsed;
          this._masterCacheTime = Date.now();
          return parsed;
        }
      }
    } catch (e) {}

    logger.info('[Dhan] Fetching instrument master CSV...');
    const resp = await axios.get(DHAN_INSTRUMENT_URL, {
      timeout: 120000,
      responseType: 'text',
    });

    const parsed = this._parseCsvMaster(resp.data);
    this._masterCache = parsed;
    this._masterCacheTime = Date.now();

    try {
      const dir = path.dirname(cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cacheFile, resp.data);
    } catch (err) {
      logger.warn(`[Dhan] Could not write master cache: ${err.message}`);
    }

    return parsed;
  }

  _parseCsvMaster(csvText) {
    // Dhan CSV columns: SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_SMST_SECURITY_ID, 
    // SEM_INSTRUMENT_NAME, SEM_EXPIRY_CODE, SEM_TRADING_SYMBOL, SEM_LOT_UNITS, 
    // SEM_TICK_SIZE, SEM_EXPIRY_DATE, SEM_STRIKE_PRICE, SEM_OPTION_TYPE, ...
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      const record = {};
      headers.forEach((h, idx) => { record[h] = values[idx]; });

      // Normalize to Angel-like format for compatibility with existing code
      records.push({
        token: record.SEM_SMST_SECURITY_ID,
        symbol: record.SEM_TRADING_SYMBOL,
        name: record.SEM_TRADING_SYMBOL,
        expiry: record.SEM_EXPIRY_DATE,
        strike: parseFloat(record.SEM_STRIKE_PRICE) || 0,
        lotsize: parseInt(record.SEM_LOT_UNITS) || 0,
        instrumenttype: record.SEM_INSTRUMENT_NAME, // OPTIDX, OPTSTK, etc.
        exch_seg: record.SEM_EXM_EXCH_ID, // NSE, BSE
        tick_size: parseFloat(record.SEM_TICK_SIZE) || 0,
        // Dhan-specific
        dhanSecurityId: record.SEM_SMST_SECURITY_ID,
        dhanExchange: record.SEM_EXM_EXCH_ID,
      });
    }
    return records;
  }

  // ── LIVE FEED (WebSocket) ───────────────────────────────────
  async subscribeLiveFeed(tokens, onTick) {
    // Dhan Live Market Feed via WebSocket
    // Reference: wss://api-feed.dhan.co?token=<access_token>&client_id=<client_id>
    const WebSocket = require('ws');
    const wsUrl = `wss://api-feed.dhan.co?token=${this.accessToken}&client_id=${this.clientId}`;

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      logger.info('[Dhan] Live feed WebSocket connected');
      // Subscribe to instruments
      // Dhan uses instrument_id array in subscription message
      const subscribeMsg = {
        RequestCode: 15, // Subscribe
        InstrumentCount: tokens.length,
        // ... instrument mapping
      };
      ws.send(JSON.stringify(subscribeMsg));
    });

    ws.on('message', (data) => {
      // Dhan sends binary tick data. Parse and call onTick.
      // TODO: Implement binary parsing per Dhan spec
      onTick(data);
    });

    ws.on('error', (err) => {
      logger.error(`[Dhan] WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      logger.warn('[Dhan] WebSocket closed');
    });

    return () => ws.close();
  }
}

module.exports = { DhanAdapter };
