// ============================================================
// MARKET DATA SERVICE (v6 — PRODUCTION FIX)
// FIXES:
// 1. url/payload scope: moved to function scope for catch access
// 2. _fetchMaster mutex: prevents 5 concurrent downloads
// 3. Master schema validation + maxContentLength
// 4. Real token-bucket rate limiter (10 req/s)
// 5. Exponential backoff on 403 + circuit breaker
// 6. Guard _startTokenRefreshLoop against duplicates
// 7. Prime LTP cache before interval polling
// 8. Retry logic fixed in fetchOptionChain
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createExpiryCalculator } = require('../utils/expiryCalculator');
const logger = require('../../logger');

const INSTRUMENT_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

// ── Network identity (placeholder — Angel One accepts this for local dev) ──
const LOCAL_IP = '127.0.0.1';
const MAC_ADDR = '00:00:00:00:00:00';

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
    this._masterFetchPromise = null;       // ✅ FIX: mutex for master download

    // Token refresh mechanism
    this.refreshToken = null;
    this._refreshInterval = null;
    this._lastTokenRefreshTime = 0;
    this._refreshPromise = null;           // mutex for token refresh

    // ✅ FIX: Rate limiting + circuit breaker state
    this._rateLimitQueue = [];
    this._isRateLimited = false;
    this._consecutive403s = 0;
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

  // ── MASTER FETCH WITH MUTEX ─────────────────────────────────
  async _fetchMaster() {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000;

    if (this._masterCache && (now - this._masterCacheTime) < cacheDuration) {
      return this._masterCache;
    }

    // ✅ FIX: Mutex — only one download at a time across all instruments
    if (this._masterFetchPromise) {
      return this._masterFetchPromise;
    }

    this._masterFetchPromise = this._doFetchMaster();
    try {
      return await this._masterFetchPromise;
    } finally {
      this._masterFetchPromise = null;
    }
  }

  async _doFetchMaster() {
    const cacheFile = path.join(process.cwd(), 'data', 'OpenAPIScripMaster.json');

    // Try file cache first
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        const now = Date.now();
        if (now - stat.mtime.getTime() < 12 * 60 * 60 * 1000) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (Array.isArray(cached) && cached.length > 0) {
            this._masterCache = cached;
            this._masterCacheTime = now;
            logger.info(`Loaded instrument master from file cache: ${cached.length} symbols`);
            return cached;
          }
        }
      }
    } catch (e) {
      logger.warn(`File cache error: ${e.message}`);
    }

    // Fetch from URL
    try {
      logger.info('Fetching instrument master from public URL...');
      const resp = await axios.get(INSTRUMENT_MASTER_URL, {
        timeout: 120000,
        responseType: 'json',
        maxContentLength: 100 * 1024 * 1024, // 100MB
      });

      if (!Array.isArray(resp.data)) {
        throw new Error(`Invalid master format: ${typeof resp.data}. Expected array.`);
      }
      if (resp.data.length === 0) {
        throw new Error('Instrument master returned empty array');
      }

      // ✅ NEW: Schema validation on first few records
      const sample = resp.data.slice(0, 3);
      for (const s of sample) {
        if (!s.token || !s.symbol || !s.name || !s.exch_seg) {
          logger.warn('Sample master record:', JSON.stringify(s));
          throw new Error('Instrument master schema mismatch: missing required fields (token, symbol, name, exch_seg)');
        }
      }

      this._masterCache = resp.data;
      this._masterCacheTime = Date.now();

      try {
        const dataDir = path.dirname(cacheFile);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(resp.data));
        logger.info(`Wrote instrument master cache: ${resp.data.length} symbols`);
      } catch (err) {
        logger.warn(`Could not write master cache: ${err.message}`);
      }

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

      // ✅ FIX: Validate we got results
      if (filtered.length === 0) {
        logger.error(
          `[${instrumentId}] CRITICAL: Filtered 0 symbols from master. ` +
          `name=${nameUpper}, exch=${optExch}, type=${instType}. ` +
          `Check if instrument profile matches Angel One master schema.`
        );
        throw new Error(`No symbols matched for ${instrumentId}`);
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

      logger.info(`[${instrumentId}] Loaded instrument master: ${filtered.length} symbols, TokenMap: ${Object.keys(inst.tokenMap).length} tokens`);
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

  // ── RATE LIMITER (Token Bucket) ─────────────────────────────
  async _rateLimit() {
    const now = Date.now();
    if (now - this.lastApiReset >= 1000) {
      this.apiCallCount = 0;
      this.lastApiReset = now;
    }

    // ✅ FIX: Real token bucket — block until window resets
    while (this.apiCallCount >= 10) {
      await new Promise(r => setTimeout(r, 200));
      if (Date.now() - this.lastApiReset >= 1000) {
        this.apiCallCount = 0;
        this.lastApiReset = Date.now();
      }
    }

    this.apiCallCount++;
  }

  // ✅ NEW: Exponential backoff after repeated 403s
  _getBackoffDelay() {
    const base = Math.min(this._consecutive403s, 5);
    return Math.pow(2, base) * 1000; // 1s, 2s, 4s, 8s, 16s, 32s
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

    // ✅ FIX: url and payload declared in FUNCTION scope so catch can access them
    const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
    const payload = {
      mode: 'LTP',
      exchangeTokens: { [indexExchange]: [indexToken] },
    };

    try {
      logger.info(`[${instrumentId}] LTP request: ${JSON.stringify(payload)} | token=${token.substring(0, 20)}...`);

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
        logger.error(`[${instrumentId}] LTP value not parseable: ${ltpVal} from ${JSON.stringify(first).substring(0, 200)}`);
        if (inst.lastLTP) {
          return { ltp: inst.lastLTP, instrumentId, cached: true };
        }
        throw new Error(`LTP not parseable: ${ltpVal}`);
      }

      inst.lastLTP = ltp;
      this._consecutive403s = 0; // ✅ Reset on success
      logger.info(`[${instrumentId}] LTP success: ${ltp}`);
      return { ltp, instrumentId };
    } catch (err) {
      logger.error(`[${instrumentId}] LTP fetch error: ${err.message}`);

      if (err.response?.status === 403) {
        this._consecutive403s++;
        const backoff = this._getBackoffDelay();
        logger.warn(`[${instrumentId}] Got 403 (consecutive: ${this._consecutive403s}). Backing off ${backoff}ms before refresh...`);

        if (this._consecutive403s >= 3) {
          logger.error(`[${instrumentId}] Too many 403s. Suspending LTP polling for this instrument.`);
          throw new Error('Rate limited - polling suspended');
        }

        await new Promise(r => setTimeout(r, backoff));
        const refreshed = await this._refreshAuthToken();
        if (refreshed) {
          logger.info(`[${instrumentId}] Token refreshed, retrying LTP fetch...`);
          try {
            const retryResp = await axios.post(url, payload, {  // ✅ url/payload now in scope
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
                this._consecutive403s = 0;
                logger.info(`[${instrumentId}] LTP retry successful after token refresh: ${ltp}`);
                return { ltp, instrumentId };
              }
            }
          } catch (retryErr) {
            logger.error(`[${instrumentId}] LTP retry failed: ${retryErr.message}`);
          }
        }
      } else {
        this._consecutive403s = 0; // ✅ Reset on non-403
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

    // ✅ FIX: url and all retry-accessible variables in function scope
    const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
    const batches = [];
    for (let i = 0; i < tokens.length; i += 50) batches.push(tokens.slice(i, i + 50));

    try {
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
        this._consecutive403s++;
        const backoff = this._getBackoffDelay();
        logger.warn(`[${instrumentId}] Got 403 on option chain (consecutive: ${this._consecutive403s}). Backing off ${backoff}ms...`);

        if (this._consecutive403s >= 3) {
          logger.error(`[${instrumentId}] Too many 403s on option chain. Suspending.`);
          throw new Error('Rate limited - option chain suspended');
        }

        await new Promise(r => setTimeout(r, backoff));
        const refreshed = await this._refreshAuthToken();
        if (refreshed && tokens.length > 0) {
          logger.info(`[${instrumentId}] Token refreshed, retrying option chain fetch...`);
          try {
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
              this._consecutive403s = 0;
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

  // ── POLLING ─────────────────────────────────────────────────
  startPolling(instrumentId, authToken, callback) {
    if (typeof authToken === 'function') {
      callback = authToken;
      authToken = null;
    }
    this.stopPolling(instrumentId);

    // ✅ NEW: Prime the cache with one immediate fetch before interval
    this.fetchIndexLTP(instrumentId, authToken)
      .then(result => {
        logger.info(`[${instrumentId}] Primed LTP cache: ${result.ltp}`);
        callback('TICK', result.ltp, Date.now());
      })
      .catch(err => {
        logger.warn(`[${instrumentId}] Prime fetch failed: ${err.message}. Will retry on interval.`);
      });

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
    logger.info(`MarketDataService auth token set: ${authToken ? authToken.substring(0, 20) + '...' : 'null'}`);
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

  // ✅ FIX: Guard against duplicate refresh intervals
  _startTokenRefreshLoop() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }

    this._refreshInterval = setInterval(async () => {
      try {
        await this._refreshAuthToken();
      } catch (err) {
        logger.error(`[TOKEN_REFRESH] Scheduled refresh failed: ${err.message}`);
      }
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
