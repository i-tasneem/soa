// ============================================================
// MARKET DATA SERVICE
// Handles instrument master loading, LTP fetching, option chain
// Rate-limited API calls to Angel One SmartAPI
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createExpiryCalculator } = require('../utils/expiryCalculator');
const logger = require('../../logger');

class MarketDataService {
  constructor(brokerConfig) {
    this.brokerConfig = brokerConfig || {};
    this.instruments = new Map();
    this.apiCallCount = 0;
    this.lastApiReset = Date.now();
    this._pollIntervals = new Map();
  }

  async loadInstrumentMaster(instrumentId, stockName = null) {
    const entry = this.instruments.get(instrumentId);
    if (!entry) {
      this.instruments.set(instrumentId, {
        profile: { name: stockName || instrumentId },
        lastLTP: null,
        lastChain: null,
        tokenMap: {},
        expiryCalc: null,
        masterFile: null,
        masterLoadedAt: 0,
      });
    }

    const inst = this.instruments.get(instrumentId);
    const cacheFile = path.join(process.cwd(), 'data', `instruments_${instrumentId}.json`);
    const cacheDuration = 12 * 60 * 60 * 1000;

    // Ensure data directory exists
    try {
      const dataDir = path.dirname(cacheFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } catch (err) {
      logger.warn(`[${instrumentId}] Could not create data directory: ${err.message}`);
    }

    // Check cache
    if (fs.existsSync(cacheFile)) {
      try {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtime.getTime() < cacheDuration) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          inst.tokenMap = this._buildTokenMap(cached);
          inst.masterFile = cached;
          inst.masterLoadedAt = Date.now();
          logger.info(`Loaded cached instrument master for ${instrumentId}`);
          return cached;
        }
      } catch (e) {
        logger.warn(`Cache parse error for ${instrumentId}: ${e.message}`);
      }
    }

    // Fetch from Angel One
    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/master/getAllScript/`;
      logger.info(`[${instrumentId}] Fetching instrument master from Angel One...`);

      const resp = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.brokerConfig.jwtToken || ''}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': 'CLIENT_LOCAL_IP',
          'X-ClientPublicIP': 'CLIENT_PUBLIC_IP',
          'X-MACAddress': 'MAC_ADDRESS',
        },
        timeout: 30000,
      });

      const master = resp.data;
      if (!master || !Array.isArray(master)) {
        throw new Error('Invalid master data');
      }

      let filtered;
      if (stockName) {
        filtered = master.filter(s =>
          s.exch_seg === inst.profile.optionExchange &&
          s.instrumenttype === 'OPTSTK' &&
          s.name === stockName
        );
      } else {
        filtered = master.filter(s =>
          s.exch_seg === inst.profile.optionExchange &&
          s.instrumenttype === 'OPTIDX' &&
          s.name === inst.profile.name
        );
      }

      try {
        fs.writeFileSync(cacheFile, JSON.stringify(filtered, null, 2));
      } catch (err) {
        logger.warn(`[${instrumentId}] Could not write cache: ${err.message}`);
      }

      inst.tokenMap = this._buildTokenMap(filtered);
      inst.masterFile = filtered;
      inst.masterLoadedAt = Date.now();

      // For stocks: auto-extract lotSize and strikeStep
      if (stockName && filtered.length > 0) {
        const first = filtered[0];
        if (first.lotsize) {
          inst.profile.lotSize = parseInt(first.lotsize) || 1;
        }
        const strikes = [...new Set(filtered.map(s => parseFloat(s.strike))).filter(Number.isFinite)].sort((a, b) => a - b);
        if (strikes.length >= 2) {
          const diffs = [];
          for (let i = 1; i < strikes.length; i++) {
            diffs.push(strikes[i] - strikes[i - 1]);
          }
          diffs.sort((a, b) => a - b);
          inst.profile.strikeStep = diffs[0] || 1;
        }
      }

      logger.info(`Loaded instrument master for ${instrumentId}: ${filtered.length} symbols`);
      return filtered;
    } catch (err) {
      logger.error(`Failed to load instrument master for ${instrumentId}: ${err.message}`);
      // Try to use cache even if expired
      if (fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          inst.tokenMap = this._buildTokenMap(cached);
          inst.masterFile = cached;
          inst.masterLoadedAt = Date.now();
          logger.info(`[${instrumentId}] Using stale cache as fallback`);
          return cached;
        } catch (_) {}
      }
      throw err;
    }
  }

  _buildTokenMap(data) {
    const map = {};
    for (const item of data || []) {
      if (item.token) {
        map[item.token] = {
          token: item.token,
          symbol: item.symbol,
          name: item.name,
          expiry: item.expiry,
          strike: parseFloat(item.strike) || 0,
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
    if (this.apiCallCount > 15) {
      await new Promise(r => setTimeout(r, 100));
    }
    this.apiCallCount++;
  }

  async fetchIndexLTP(instrumentId, authToken) {
    await this._rateLimit();

    const inst = this.instruments.get(instrumentId);
    if (!inst || !inst.profile) {
      throw new Error(`Instrument ${instrumentId} not registered`);
    }

    const { indexExchange, indexToken } = inst.profile;
    if (!indexExchange || !indexToken) {
      throw new Error(`Missing index config for ${instrumentId}`);
    }

    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
      const resp = await axios.post(url, {
        mode: 'LTP',
        exchangeTokens: {
          [indexExchange]: [indexToken],
        },
      }, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
        },
        timeout: 10000,
      });

      const data = resp.data;
      if (data && data.data && data.data.fetched && data.data.fetched.length > 0) {
        const ltp = parseFloat(data.data.fetched[0].ltp);
        inst.lastLTP = ltp;
        return { ltp, instrumentId };
      }
      throw new Error('No LTP data');
    } catch (err) {
      logger.error(`LTP fetch error for ${instrumentId}: ${err.message}`);
      throw err;
    }
  }

  async fetchOptionChain(instrumentId, spotPrice, authToken) {
    await this._rateLimit();

    const inst = this.instruments.get(instrumentId);
    if (!inst || !inst.profile) {
      throw new Error(`Instrument ${instrumentId} not registered`);
    }

    const { strikeStep, optionExchange, name } = inst.profile;
    const expiryCalc = inst.expiryCalc || createExpiryCalculator(inst.profile);
    inst.expiryCalc = expiryCalc;

    const expiry = expiryCalc.getCurrentExpiry();
    if (!expiry) {
      throw new Error(`Could not calculate expiry for ${instrumentId}`);
    }

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
      return { chainData: [], premiums: { ce: null, pe: null }, instrumentId };
    }

    try {
      const url = `${this.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
      const batches = [];
      for (let i = 0; i < tokens.length; i += 50) {
        batches.push(tokens.slice(i, i + 50));
      }

      const allResults = [];
      for (const batch of batches) {
        const resp = await axios.post(url, {
          mode: 'FULL',
          exchangeTokens: {
            [optionExchange]: batch,
          },
        }, {
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
          },
          timeout: 15000,
        });

        if (resp.data && resp.data.data && resp.data.data.fetched) {
          allResults.push(...resp.data.data.fetched);
        }
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
      logger.error(`Option chain fetch error for ${instrumentId}: ${err.message}`);
      throw err;
    }
  }

  startPolling(instrumentId, authToken, callback) {
    this.stopPolling(instrumentId);

    const ltpInterval = setInterval(async () => {
      try {
        const result = await this.fetchIndexLTP(instrumentId, authToken);
        callback('TICK', result.ltp, instrumentId);
      } catch (err) {
        // Silently fail — connection will retry
      }
    }, 2000);

    const chainInterval = setInterval(async () => {
      try {
        const inst = this.instruments.get(instrumentId);
        if (!inst || !inst.lastLTP) return;
        const result = await this.fetchOptionChain(instrumentId, inst.lastLTP, authToken);
        callback('CHAIN', result.chainData, result.premiums, instrumentId);
      } catch (err) {
        // Silently fail
      }
    }, 5000);

    this._pollIntervals.set(instrumentId, { ltpInterval, chainInterval });
  }

  stopPolling(instrumentId) {
    const intervals = this._pollIntervals.get(instrumentId);
    if (intervals) {
      clearInterval(intervals.ltpInterval);
      clearInterval(intervals.chainInterval);
      this._pollIntervals.delete(instrumentId);
    }
  }

  setAuthToken(authToken) {
    this.authToken = authToken;
  }
}

module.exports = new MarketDataService({});
module.exports.MarketDataService = MarketDataService;
