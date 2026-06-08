// ============================================================
// MARKET DATA SERVICE (v5 — Phase 2)
// CRITICAL FIX: Added missing Angel One headers (X-ClientLocalIP etc.)
// Extensive response logging to debug LTP fetch failures
// FIX: Real local IP/MAC detection; token refresh mutex
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createExpiryCalculator } = require('../utils/expiryCalculator');
const logger = require('../../logger');

const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

// ── Real network identity (not fake 127.0.0.1) ─────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.mac || '00:00:00:00:00:00';
      }
    }
  }
  return '00:00:00:00:00:00';
}

const LOCAL_IP = getLocalIP();
const MAC_ADDR = getMacAddress();

class MarketDataService {
  constructor(brokerConfig) {
    this.brokerConfig = brokerConfig || {};
    this.instruments = new Map();
    this.apiCallCount = 0;
    this.lastApiReset = Date.now();
    this._pollIntervals = new Map();
    this.authToken = null;
    this._masterCache = null;
    this._masterCacheTime = 0;

    // Token refresh mechanism
    this.refreshToken = null;
    this._refreshInterval = null;
    this._lastTokenRefreshTime = 0;
    this._refreshPromise = null;  // FIX: mutex for token refresh
  }

  _headers(token) {
    return {
      'Authorization': `Bearer ${token || this.authToken || ''}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': LOCAL_IP,
      'X-ClientPublicIP': LOCAL_IP,
      'X-MACAddress': MAC_ADDR,
      'X-PrivateKey': this.brokerConfig.apiKey || '',
    };
  }

  async _fetchMaster() {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000;

    if (this._masterCache && (now - this._masterCacheTime) < cacheDuration) {
      return this._masterCache;
    }

    const cacheFile = path.join(process.cwd(), 'data', 'OpenAPIScripMaster.json');
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        if (now - stat.mtime.getTime() < cacheDuration) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          this._masterCache = cached;
          this._masterCacheTime = now;
          logger.info(`Loaded instrument master from file cache: ${cached.length} symbols`);
          return cached;
        }
      }
    } catch (e) { logger.warn(`File cache error: ${e.message}`); }

    try {
      logger.info('Fetching instrument master from public URL...');
      const resp = await axios.get(INSTRUMENT_MASTER_URL, { timeout: 60000, responseType: 'json' });
      if (!Array.isArray(resp.data)) throw new Error(`Invalid master format: ${typeof resp.data}`);
      this._masterCache = resp.data;
      this._masterCacheTime = now;
      try {
        const dataDir = path.dirname(cacheFile);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(resp.data, null, 2));
      } catch (err) { logger.warn(`Could not write master cache: ${err.message}`); }
      logger.info(`Fetched instrument master: ${resp.data.length} symbols`);
      return resp.data;
    } catch (err) {
      logger.error(`Failed to fetch instrument master: ${err.message}`);
      throw err;
    }
  }

  async loadInstrumentMaster(instrumentId, stockName = null, profile = null) {
    const entry = this.instruments.get(instrumentId);
    if (!entry) {
      this.instruments.set(instrumentId, {
        profile: profile || { name: stockName || instrumentId },
        lastLTP: null, lastChain: null, tokenMap: {}, expiryCalc: null,
        masterFile: null, masterLoadedAt: 0,
      });
    } else if (profile) {
      entry.profile = { ...entry.profile, ...profile };
    }
    const inst = this.instruments.get(instrumentId);

    try {
      const master = await this._fetchMaster();
      const nameUpper = (stockName || inst.profile.name || instrumentId).toUpperCase();
      const optExch = inst.profile.optionExchange;
      const instType = inst.profile.instrumenttype;

      logger.info(`[${instrumentId}] Filtering master: name=${nameUpper}, exch=${optExch}, type=${instType}`);

      let filtered = master.filter(s =>
        s.exch_seg === optExch &&
        s.instrumenttype === instType &&
        s.name && s.name.toUpperCase() === nameUpper
      );

      if (filtered.length === 0) {
        filtered = master.filter(s =>
          s.exch_seg === optExch &&
          s.instrumenttype === instType &&
          s.symbol && s.symbol.toUpperCase().startsWith(nameUpper)
        );
        if (filtered.length > 0) {
          logger.info(`[${instrumentId}] Fallback symbol-prefix match: ${filtered.length} symbols`);
        }
      }

      if (filtered.length === 0) {
        filtered = master.filter(s =>
          s.exch_seg === optExch &&
          s.instrumenttype === instType &&
          s.name && s.name.toUpperCase().includes(nameUpper)
        );
        if (filtered.length > 0) {
          logger.info(`[${instrumentId}] Fallback name-includes match: ${filtered.length} symbols`);
        }
      }

      inst.tokenMap = this._buildTokenMap(filtered);
      inst.masterFile = filtered;
      inst.masterLoadedAt = Date.now();

      if (stockName && filtered.length > 0) {
        const first = filtered[0];
        if (first.lotsize) inst.profile.lotSize = parseInt(first.lotsize) || 1;
        const strikes = [...new Set(filtered.map(s => parseFloat(s.strike) / 100).filter(Number.isFinite))].sort((a, b) => a - b);
        if (strikes.length >= 2) {
          const diffs = [];
          for (let i = 1; i < strikes.length; i++) diffs.push(strikes[i] - strikes[i - 1]);
          diffs.sort((a, b) => a - b);
          inst.profile.strikeStep = diffs[0] || 1;
        }
      }

      logger.info(`[${instrumentId}] Loaded instrument master: ${filtered.length} symbols`);
      return filtered;
    } catch (err) {
      logger.error(`[${instrumentId}] Failed to load instrument master: ${err.message}`);
      throw err;
    }
  }

  _buildTokenMap(data) {
    const map = {};
    for (const item of data || []) {
      if (item.token) {
        const strikeRupees = parseFloat(item.strike) / 100 || 0;
        map[item.token] = {
          token: item.token,
          symbol: item.symbol,
          name: item.name,
          expiry: item.expiry,
          strike: strikeRupees,
          lotsize: item.lotsize,
          instrumenttype: item.instrumenttype,
          exch_seg: item.exch_seg,
        };
      }
    }
    return map;
  }

  async _rateLimit() {
    const now = Date.now();
    if (now - this.lastApiReset >= 1000) {
      this.apiCallCount = 0;
      this.lastApiReset = now;
    }
    if (this.apiCallCount >= 15) {
      await new Promise(r => setTimeout(r, 100));
      if (Date.now() - this.lastApiReset < 1000 && this.apiCallCount >= 15) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    this.apiCallCount++;
  }

  async fetchIndexLTP(instrumentId, authToken) {
    await this._rateLimit();
    const inst = this.instruments.get(instrumentId);
    if (!inst || !inst.profile) throw new Error(`Instrument ${instrumentId} not registered`);
    const { indexExchange, indexToken } = inst.profile;
    if (!indexExchange || !indexToken) throw new Error(`Missing index config for ${instrumentId}`);

    const token = authToken || this.authToken || '';
    if (!token) {
      logger.error(`[${instrumentId}] No auth token available`);
      throw new Error('No auth token');
    }

    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
      const payload = {
        mode: 'LTP',
        exchangeTokens: { [indexExchange]: [indexToken] },
      };

      logger.info(`[${instrumentId}] LTP request: ${JSON.stringify(payload)} | token=${token.substring(0,20)}...`);

      const resp = await axios.post(url, payload, {
        headers: this._headers(token),
        timeout: 10000,
      });

      const respStr = JSON.stringify(resp.data);
      logger.info(`[${instrumentId}] LTP response: ${respStr.substring(0, 800)}`);

      const responseData = resp.data;
      let fetched = null;

      if (responseData && typeof responseData === 'object') {
        if (responseData.data && typeof responseData.data === 'object') {
          if (Array.isArray(responseData.data.fetched)) {
            fetched = responseData.data.fetched;
            logger.info(`[${instrumentId}] Parsed structure 1: data.fetched, len=${fetched.length}`);
          } else if (Array.isArray(responseData.data)) {
            fetched = responseData.data;
            logger.info(`[${instrumentId}] Parsed structure 2: data array, len=${fetched.length}`);
          } else if (responseData.data.ltp !== undefined || responseData.data.lastTradedPrice !== undefined) {
            fetched = [responseData.data];
            logger.info(`[${instrumentId}] Parsed structure 3: data object with ltp`);
          }
        } else if (Array.isArray(responseData.fetched)) {
          fetched = responseData.fetched;
          logger.info(`[${instrumentId}] Parsed structure 4: root fetched, len=${fetched.length}`);
        } else if (Array.isArray(responseData)) {
          fetched = responseData;
          logger.info(`[${instrumentId}] Parsed structure 5: root array, len=${fetched.length}`);
        } else if (responseData.ltp !== undefined || responseData.lastTradedPrice !== undefined) {
          fetched = [responseData];
          logger.info(`[${instrumentId}] Parsed structure 6: root object with ltp`);
        }
      }

      if (!fetched) {
        logger.error(`[${instrumentId}] Could not parse any known response structure`);
        throw new Error(`Unparseable LTP response: ${respStr.substring(0, 200)}`);
      }

      if (fetched.length === 0) {
        logger.warn(`[${instrumentId}] LTP fetched array is empty (market closed or invalid token?)`);
        if (inst.lastLTP) {
          logger.info(`[${instrumentId}] Returning cached LTP: ${inst.lastLTP}`);
          return { ltp: inst.lastLTP, instrumentId, cached: true };
        }
        throw new Error('No LTP data - empty fetched array');
      }

      const first = fetched[0];
      const ltpVal = first.ltp || first.lastTradedPrice || first.close || first.price;
      const ltp = parseFloat(ltpVal);

      if (!Number.isFinite(ltp)) {
        logger.error(`[${instrumentId}] LTP value not parseable: ${ltpVal} from ${JSON.stringify(first).substring(0,200)}`);
        if (inst.lastLTP) {
          return { ltp: inst.lastLTP, instrumentId, cached: true };
        }
        throw new Error(`LTP not parseable: ${ltpVal}`);
      }

      inst.lastLTP = ltp;
      logger.info(`[${instrumentId}] LTP success: ${ltp}`);
      return { ltp, instrumentId };
    } catch (err) {
      logger.error(`[${instrumentId}] LTP fetch error: ${err.message}`);

      if (err.response?.status === 403) {
        logger.warn(`[${instrumentId}] Got 403 Forbidden - attempting token refresh...`);
        const refreshed = await this._refreshAuthToken();
        if (refreshed) {
          logger.info(`[${instrumentId}] Token refreshed, retrying LTP fetch...`);
          try {
            const retryResp = await axios.post(url, payload, {
              headers: this._headers(),
              timeout: 10000,
            });

            const responseData = retryResp.data;
            let fetched = null;
            if (responseData?.data?.fetched) fetched = responseData.data.fetched;
            else if (responseData?.fetched) fetched = responseData.fetched;
            else if (Array.isArray(responseData?.data)) fetched = responseData.data;
            else if (Array.isArray(responseData)) fetched = responseData;

            if (fetched && fetched.length > 0) {
              const first = fetched[0];
              const ltpVal = first.ltp || first.lastTradedPrice || first.close || first.price;
              const ltp = parseFloat(ltpVal);
              if (Number.isFinite(ltp)) {
                inst.lastLTP = ltp;
                logger.info(`[${instrumentId}] LTP retry successful after token refresh: ${ltp}`);
                return { ltp, instrumentId };
              }
            }
          } catch (retryErr) {
            logger.error(`[${instrumentId}] LTP retry failed: ${retryErr.message}`);
          }
        }
      }

      if (inst && inst.lastLTP) {
        logger.info(`[${instrumentId}] Returning cached LTP after error: ${inst.lastLTP}`);
        return { ltp: inst.lastLTP, instrumentId, cached: true };
      }
      throw err;
    }
  }

  async fetchOptionChain(instrumentId, spotPrice, authToken) {
    await this._rateLimit();
    const inst = this.instruments.get(instrumentId);
    if (!inst || !inst.profile) throw new Error(`Instrument ${instrumentId} not registered`);

    const { strikeStep, optionExchange, name } = inst.profile;
    const expiryCalc = inst.expiryCalc || createExpiryCalculator(inst.profile);
    inst.expiryCalc = expiryCalc;

    const expiry = expiryCalc.getCurrentExpiry();
    if (!expiry) throw new Error(`Could not calculate expiry for ${instrumentId}`);

    const isStock = inst.profile.instrumenttype === 'OPTSTK';
    const strikeCount = isStock ? 5 : 10;
    const minStrike = Math.round((spotPrice - strikeStep * strikeCount) / strikeStep) * strikeStep;
    const maxStrike = Math.round((spotPrice + strikeStep * strikeCount) / strikeStep) * strikeStep;

    const tokens = [];
    const strikeMap = {};
    for (const [token, info] of Object.entries(inst.tokenMap || {})) {
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
      logger.warn(`[${instrumentId}] No option tokens matched for expiry ${expiry}, spot ${spotPrice}, range ${minStrike}-${maxStrike}. TokenMap size: ${Object.keys(inst.tokenMap || {}).length}`);
      if (inst.lastChain) {
        const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
        const atmRow = inst.lastChain.find(r => r.strikePrice === atmStrike);
        const premiums = {
          ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
          pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
          atmStrike,
        };
        return { chainData: inst.lastChain, premiums, instrumentId, cached: true };
      }
      return { chainData: [], premiums: { ce: null, pe: null }, instrumentId };
    }

    const token = authToken || this.authToken || '';

    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
      const batches = [];
      for (let i = 0; i < tokens.length; i += 50) batches.push(tokens.slice(i, i + 50));

      const allResults = [];
      for (const batch of batches) {
        const resp = await axios.post(url, {
          mode: 'FULL',
          exchangeTokens: { [optionExchange]: batch },
        }, {
          headers: this._headers(token),
          timeout: 15000,
        });

        const responseData = resp.data;
        let fetched = null;
        if (responseData && typeof responseData === 'object') {
          if (responseData.data && typeof responseData.data === 'object') {
            if (Array.isArray(responseData.data.fetched)) {
              fetched = responseData.data.fetched;
            } else if (Array.isArray(responseData.data)) {
              fetched = responseData.data;
            }
          } else if (Array.isArray(responseData.fetched)) {
            fetched = responseData.fetched;
          } else if (Array.isArray(responseData)) {
            fetched = responseData;
          }
        }
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

      inst.lastChain = chainData;
      const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
      const atmRow = chainData.find(r => r.strikePrice === atmStrike);
      const premiums = {
        ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
        pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
        atmStrike,
      };

      return { chainData, premiums, instrumentId };
    } catch (err) {
      logger.error(`[${instrumentId}] Option chain fetch error: ${err.message}`);

      if (err.response?.status === 403) {
        logger.warn(`[${instrumentId}] Got 403 Forbidden on option chain - attempting token refresh...`);
        const refreshed = await this._refreshAuthToken();
        if (refreshed && tokens.length > 0) {
          logger.info(`[${instrumentId}] Token refreshed, retrying option chain fetch...`);
          try {
            const batches = [];
            for (let i = 0; i < tokens.length; i += 50) batches.push(tokens.slice(i, i + 50));

            const allResults = [];
            for (const batch of batches) {
              const resp = await axios.post(url, {
                mode: 'FULL',
                exchangeTokens: { [optionExchange]: batch },
              }, {
                headers: this._headers(),
                timeout: 15000,
              });

              const responseData = resp.data;
              let fetched = null;
              if (responseData?.data?.fetched) fetched = responseData.data.fetched;
              else if (responseData?.fetched) fetched = responseData.fetched;
              else if (Array.isArray(responseData?.data)) fetched = responseData.data;
              else if (Array.isArray(responseData)) fetched = responseData;
              if (Array.isArray(fetched)) allResults.push(...fetched);
            }

            if (allResults.length > 0) {
              const chainData = [];
              const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
              for (const strike of strikes) {
                const ceData = allResults.find(r => r.symbolToken === strikeMap[strike].CE);
                const peData = allResults.find(r => r.symbolToken === strikeMap[strike].PE);
                chainData.push({
                  strikePrice: strike,
                  CE: ceData ? { ltp: parseFloat(ceData.ltp) || 0, oi: parseInt(ceData.oi) || 0, volume: parseInt(ceData.volume) || 0, bid: parseFloat(ceData.bid) || 0, ask: parseFloat(ceData.ask) || 0, token: ceData.symbolToken } : null,
                  PE: peData ? { ltp: parseFloat(peData.ltp) || 0, oi: parseInt(peData.oi) || 0, volume: parseInt(peData.volume) || 0, bid: parseFloat(peData.bid) || 0, ask: parseFloat(peData.ask) || 0, token: peData.symbolToken } : null,
                });
              }

              inst.lastChain = chainData;
              const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
              const atmRow = chainData.find(r => r.strikePrice === atmStrike);
              const premiums = {
                ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
                pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
                atmStrike,
              };
              logger.info(`[${instrumentId}] Option chain retry successful after token refresh`);
              return { chainData, premiums, instrumentId };
            }
          } catch (retryErr) {
            logger.error(`[${instrumentId}] Option chain retry failed: ${retryErr.message}`);
          }
        }
      }

      if (inst.lastChain) {
        const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
        const atmRow = inst.lastChain.find(r => r.strikePrice === atmStrike);
        const premiums = {
          ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
          pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
          atmStrike,
        };
        return { chainData: inst.lastChain, premiums, instrumentId, cached: true };
      }
      throw err;
    }
  }

  startPolling(instrumentId, authToken, callback) {
    if (typeof authToken === 'function') {
      callback = authToken;
      authToken = null;
    }
    this.stopPolling(instrumentId);

    const ltpInterval = setInterval(async () => {
      try {
        const result = await this.fetchIndexLTP(instrumentId, authToken);
        callback('TICK', result.ltp, Date.now());
      } catch (err) {
        const inst = this.instruments.get(instrumentId);
        if (inst && inst.lastLTP) {
          logger.info(`[${instrumentId}] Polling fallback: broadcasting cached LTP ${inst.lastLTP}`);
          callback('TICK', inst.lastLTP, Date.now());
        } else {
          logger.warn(`[${instrumentId}] No cached LTP available for fallback`);
        }
      }
    }, 2000);

    const chainInterval = setInterval(async () => {
      try {
        const inst = this.instruments.get(instrumentId);
        if (!inst || !inst.lastLTP) return;
        const result = await this.fetchOptionChain(instrumentId, inst.lastLTP, authToken);
        callback('CHAIN', result.chainData, result.premiums, Date.now());
      } catch (err) {
        const inst = this.instruments.get(instrumentId);
        if (inst && inst.lastChain && inst.lastLTP) {
          logger.info(`[${instrumentId}] Polling fallback: broadcasting cached chain`);
          const atmStrike = Math.round(inst.lastLTP / inst.profile.strikeStep) * inst.profile.strikeStep;
          const atmRow = inst.lastChain.find(r => r.strikePrice === atmStrike);
          const premiums = {
            ce: atmRow?.CE ? { premium: atmRow.CE.ltp, strike: atmStrike, token: atmRow.CE.token } : null,
            pe: atmRow?.PE ? { premium: atmRow.PE.ltp, strike: atmStrike, token: atmRow.PE.token } : null,
            atmStrike,
          };
          callback('CHAIN', inst.lastChain, premiums, Date.now());
        }
      }
    }, 5000);

    this._pollIntervals.set(instrumentId, { ltpInterval, chainInterval });
    logger.info(`[${instrumentId}] Polling started (LTP 2s, Chain 5s)`);
  }

  stopPolling(instrumentId) {
    const intervals = this._pollIntervals.get(instrumentId);
    if (intervals) {
      clearInterval(intervals.ltpInterval);
      clearInterval(intervals.chainInterval);
      this._pollIntervals.delete(instrumentId);
    }
  }

  setAuthToken(authToken, refreshToken = null) {
    this.authToken = authToken;
    if (refreshToken) {
      this.refreshToken = refreshToken;
      this.brokerConfig.refreshToken = refreshToken;
      this._startTokenRefreshLoop();
    }
    this.brokerConfig.jwtToken = authToken;
    logger.info(`MarketDataService auth token set: ${authToken ? authToken.substring(0,20) + '...' : 'null'}`);
  }

  // FIX: mutex for token refresh — only one in-flight request at a time
  async _refreshAuthToken() {
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
      logger.warn('No refresh token available for auto-refresh');
      return false;
    }

    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/auth/angelbroking/jwt/v1/generateTokens`;
      const resp = await axios.post(url, {
        refreshToken: this.refreshToken,
      }, {
        headers: this._headers(),
        timeout: 10000,
      });

      if (resp.data && (resp.data.status === true || resp.data.success === true)) {
        const newToken = resp.data.data.jwtToken;
        this.authToken = newToken;
        this.brokerConfig.jwtToken = newToken;
        this._lastTokenRefreshTime = Date.now();
        logger.info(`[TOKEN_REFRESH] Successfully refreshed JWT token at ${new Date().toISOString()}`);
        return true;
      } else {
        logger.error(`[TOKEN_REFRESH] Failed: ${resp.data?.message || 'Unknown error'}`);
        return false;
      }
    } catch (err) {
      logger.error(`[TOKEN_REFRESH] Error: ${err.message}`);
      return false;
    }
  }

  _startTokenRefreshLoop() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
    }

    this._refreshInterval = setInterval(async () => {
      await this._refreshAuthToken();
    }, 30 * 60 * 1000);

    logger.info('[TOKEN_REFRESH] Token refresh loop started (every 30 minutes)');
  }

  _stopTokenRefreshLoop() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
      logger.info('[TOKEN_REFRESH] Token refresh loop stopped');
    }
  }
}

module.exports = new MarketDataService({});
module.exports.MarketDataService = MarketDataService;
