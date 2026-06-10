// ============================================================
// ANGEL ADAPTER — Angel One SmartAPI Implementation
// Extracted from original MarketDataService v6
// All Angel-specific URLs, headers, response parsing isolated here.
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { BrokerAdapter } = require('./BrokerAdapter');
const logger = require('../logger');

const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';
const LOCAL_IP = '127.0.0.1';
const MAC_ADDR = '00:00:00:00:00:00';

class AngelAdapter extends BrokerAdapter {
  constructor(config = {}) {
    super(config);
    this.name = 'angel';
    this.baseUrl = config.baseUrl || 'https://apiconnect.angelone.in';
    this.apiKey = config.apiKey || '';
    this.clientId = config.clientId || '';
    this.password = config.password || '';
    this.totpSecret = config.totpSecret || '';

    // Rate limiting state
    this.apiCallCount = 0;
    this.lastApiReset = Date.now();
    this._consecutive403s = 0;
    this._masterCache = null;
    this._masterCacheTime = 0;
    this._masterFetchPromise = null;

    // Token refresh
    this._refreshPromise = null;
    this._refreshInterval = null;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.authToken || ''}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': LOCAL_IP,
      'X-ClientPublicIP': LOCAL_IP,
      'X-MACAddress': MAC_ADDR,
      'X-PrivateKey': this.apiKey,
    };
  }

  // ── RATE LIMITER (Token Bucket) ─────────────────────────────
  async rateLimit() {
    const now = Date.now();
    if (now - this.lastApiReset >= 1000) {
      this.apiCallCount = 0;
      this.lastApiReset = now;
    }
    while (this.apiCallCount >= 10) {
      await new Promise(r => setTimeout(r, 200));
      if (Date.now() - this.lastApiReset >= 1000) {
        this.apiCallCount = 0;
        this.lastApiReset = Date.now();
      }
    }
    this.apiCallCount++;
  }

  _getBackoffDelay() {
    const base = Math.min(this._consecutive403s, 5);
    return Math.pow(2, base) * 1000;
  }

  // ── AUTHENTICATION ─────────────────────────────────────────
  async authenticate() {
    const otplib = require('otplib');
    const totp = otplib.authenticator.generate(this.totpSecret);
    logger.info(`[Angel] TOTP generated`);

    const loginUrl = `${this.baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`;
    const resp = await axios.post(loginUrl, {
      clientcode: this.clientId,
      password: this.password,
      totp: totp,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': LOCAL_IP,
        'X-ClientPublicIP': LOCAL_IP,
        'X-MACAddress': MAC_ADDR,
        'X-PrivateKey': this.apiKey,
      },
      timeout: 30000,
    });

    const isSuccess = resp.data?.success === true || resp.data?.status === true;
    if (!isSuccess || !resp.data?.data) {
      throw new Error(resp.data?.message || resp.data?.errorCode || 'Angel One authentication failed');
    }

    this.authToken = resp.data.data.jwtToken;
    this.refreshToken = resp.data.data.refreshToken;
    this.tokenExpiry = Date.now() + 30 * 60 * 1000; // 30 min
    this._consecutive403s = 0;

    logger.info('[Angel] Authenticated successfully');
    return {
      token: this.authToken,
      refreshToken: this.refreshToken,
      feedToken: resp.data.data.feedToken,
      expiry: this.tokenExpiry,
    };
  }

  async refreshAuthToken() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._doRefreshAuthToken();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _doRefreshAuthToken() {
    if (!this.refreshToken) {
      logger.warn('[Angel] No refresh token available');
      return false;
    }
    try {
      const url = `${this.baseUrl}/rest/auth/angelbroking/jwt/v1/generateTokens`;
      const resp = await axios.post(url, { refreshToken: this.refreshToken }, {
        headers: this._headers(),
        timeout: 10000,
      });
      if (resp.data && (resp.data.status === true || resp.data.success === true)) {
        this.authToken = resp.data.data.jwtToken;
        this.tokenExpiry = Date.now() + 30 * 60 * 1000;
        logger.info('[Angel] Token refreshed');
        return true;
      }
      return false;
    } catch (err) {
      logger.error(`[Angel] Token refresh failed: ${err.message}`);
      return false;
    }
  }

  startTokenRefreshLoop() {
    if (this._refreshInterval) clearInterval(this._refreshInterval);
    this._refreshInterval = setInterval(async () => {
      try { await this.refreshAuthToken(); } catch (e) {}
    }, 30 * 60 * 1000);
  }

  stopTokenRefreshLoop() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
  }

  // ── MARKET DATA ────────────────────────────────────────────
  async getSpotLTP(instrumentId, exchange, token) {
    await this.rateLimit();
    if (!this.authToken) throw new Error('Not authenticated');

    const url = `${this.baseUrl}/rest/secure/angelbroking/market/v1/quote/`;
    const payload = {
      mode: 'LTP',
      exchangeTokens: { [exchange]: [token] },
    };

    try {
      const resp = await axios.post(url, payload, {
        headers: this._headers(),
        timeout: 10000,
      });
      const fetched = this._parseFetched(resp.data);
      if (!fetched || fetched.length === 0) {
        throw new Error('Empty LTP response');
      }
      const first = fetched[0];
      const ltp = parseFloat(first.ltp || first.lastTradedPrice || first.close || first.price);
      if (!Number.isFinite(ltp)) throw new Error(`Invalid LTP: ${JSON.stringify(first).slice(0,200)}`);
      this._consecutive403s = 0;
      return { ltp, timestamp: Date.now(), raw: first };
    } catch (err) {
      if (err.response?.status === 403) {
        this._consecutive403s++;
        const backoff = this._getBackoffDelay();
        logger.warn(`[Angel] 403 error (consecutive: ${this._consecutive403s}), backoff ${backoff}ms`);
        if (this._consecutive403s >= 3) throw new Error('Rate limited - too many 403s');
        await new Promise(r => setTimeout(r, backoff));
        await this.refreshAuthToken();
        return this.getSpotLTP(instrumentId, exchange, token); // retry once
      }
      throw err;
    }
  }

  async getQuotes(exchangeTokens, mode = 'LTP') {
    await this.rateLimit();
    if (!this.authToken) throw new Error('Not authenticated');

    const url = `${this.baseUrl}/rest/secure/angelbroking/market/v1/quote/`;
    const resp = await axios.post(url, { mode, exchangeTokens }, {
      headers: this._headers(),
      timeout: 15000,
    });
    const fetched = this._parseFetched(resp.data);
    return { fetched: fetched || [], timestamp: Date.now() };
  }

  async getOptionChain(instrumentId, spotPrice, expiry, tokenMap, profile) {
    // Angel One does not have a dedicated option chain endpoint.
    // We must batch-quote tokens for the relevant strikes.
    const { strikeStep, optionExchange } = profile;
    const strikeCount = profile.instrumenttype === 'OPTSTK' ? 5 : 10;
    const minStrike = Math.round((spotPrice - strikeStep * strikeCount) / strikeStep) * strikeStep;
    const maxStrike = Math.round((spotPrice + strikeStep * strikeCount) / strikeStep) * strikeStep;

    const tokens = [];
    const strikeMap = {};
    for (const [token, info] of Object.entries(tokenMap || {})) {
      if (info.exch_seg === optionExchange && info.expiry === expiry) {
        const strike = info.strike;
        if (strike >= minStrike && strike <= maxStrike) {
          tokens.push(token);
          if (!strikeMap[strike]) strikeMap[strike] = { CE: null, PE: null };
          if (info.symbol && info.symbol.includes('CE')) strikeMap[strike].CE = token;
          if (info.symbol && info.symbol.includes('PE')) strikeMap[strike].PE = token;
        }
      }
    }

    if (tokens.length === 0) {
      return { chainData: [], premiums: { ce: null, pe: null, atmStrike: null }, tokens: [] };
    }

    const batches = [];
    for (let i = 0; i < tokens.length; i += 50) batches.push(tokens.slice(i, i + 50));

    const allResults = [];
    for (const batch of batches) {
      const { fetched } = await this.getQuotes({ [optionExchange]: batch }, 'FULL');
      if (Array.isArray(fetched)) allResults.push(...fetched);
    }

    const chainData = [];
    const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
    for (const strike of strikes) {
      const ceData = allResults.find(r => r.symbolToken === strikeMap[strike].CE);
      const peData = allResults.find(r => r.symbolToken === strikeMap[strike].PE);
      chainData.push({
        strikePrice: strike,
        CE: ceData ? {
          ltp: parseFloat(ceData.ltp) || 0,
          oi: parseInt(ceData.oi) || 0,
          volume: parseInt(ceData.volume) || 0,
          bid: parseFloat(ceData.bid) || 0,
          ask: parseFloat(ceData.ask) || 0,
          token: ceData.symbolToken,
        } : null,
        PE: peData ? {
          ltp: parseFloat(peData.ltp) || 0,
          oi: parseInt(peData.oi) || 0,
          volume: parseInt(peData.volume) || 0,
          bid: parseFloat(peData.bid) || 0,
          ask: parseFloat(peData.ask) || 0,
          token: peData.symbolToken,
        } : null,
      });
    }

    const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
    const atmRow = chainData.find(r => r.strikePrice === atmStrike);
    const premiums = {
      ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
      pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
      atmStrike,
    };

    return { chainData, premiums, tokens };
  }

  async getHistoricalData(instrumentId, exchange, token, interval, from, to) {
    // Angel One historical API endpoint
    await this.rateLimit();
    const url = `${this.baseUrl}/rest/secure/angelbroking/historical/v1/getData`;
    const resp = await axios.get(url, {
      params: { exchange, symboltoken: token, interval, fromdate: from, todate: to },
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
    const cacheFile = path.join(process.cwd(), 'data', 'OpenAPIScripMaster.json');

    // Try file cache
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtime.getTime() < 12 * 60 * 60 * 1000) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (Array.isArray(cached) && cached.length > 0) {
            this._masterCache = cached;
            this._masterCacheTime = Date.now();
            return cached;
          }
        }
      }
    } catch (e) {}

    // Fetch from URL
    logger.info('[Angel] Fetching instrument master...');
    const resp = await axios.get(INSTRUMENT_MASTER_URL, {
      timeout: 120000,
      responseType: 'json',
      maxContentLength: 100 * 1024 * 1024,
    });

    if (!Array.isArray(resp.data)) throw new Error('Invalid master format');
    if (resp.data.length === 0) throw new Error('Empty master');

    this._masterCache = resp.data;
    this._masterCacheTime = Date.now();

    try {
      const dir = path.dirname(cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(resp.data));
    } catch (err) {
      logger.warn(`[Angel] Could not write master cache: ${err.message}`);
    }

    return resp.data;
  }

  // ── PARSER ─────────────────────────────────────────────────
  _parseFetched(responseData) {
    if (!responseData || typeof responseData !== 'object') return null;
    if (responseData.data && typeof responseData.data === 'object') {
      if (Array.isArray(responseData.data.fetched)) return responseData.data.fetched;
      if (Array.isArray(responseData.data)) return responseData.data;
      if (responseData.data.ltp !== undefined || responseData.data.lastTradedPrice !== undefined) return [responseData.data];
    }
    if (Array.isArray(responseData.fetched)) return responseData.fetched;
    if (Array.isArray(responseData)) return responseData;
    if (responseData.ltp !== undefined || responseData.lastTradedPrice !== undefined) return [responseData];
    return null;
  }
}

module.exports = { AngelAdapter };
