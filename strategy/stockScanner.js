// ============================================================
// STOCK SCANNER (FINAL FIX — Phase 2)
// Liquidity check: spread < 8% AND premium > minPremium
// Only activates stocks that pass the filter
// FIX: Fetch actual underlying cash-market LTP instead of median strike
// ============================================================

const logger = require('../logger');

class StockScanner {
  constructor(marketDataService, multiOrchestrator) {
    this.watchlist = (process.env.STOCK_WATCHLIST || 'RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK').split(',').map(s => s.trim().toUpperCase());
    this.activeStockEngines = new Map(); // stockName -> { engineId, addedAt }
    this.scanResults = [];
    this.marketData = marketDataService;
    this.multiOrchestrator = multiOrchestrator;
    this._interval = null;
  }

  async scan() {
    for (const stockName of this.watchlist) {
      if (this.activeStockEngines.has(stockName)) continue;

      try {
        // Create a temporary stockId to fetch underlying LTP
        const stockId = `STOCK_${stockName}`;

        // Load instrument master first (needed for token lookup)
        await this.marketData.loadInstrumentMaster(stockId, stockName);

        const inst = this.marketData.instruments.get(stockId);
        if (!inst || !inst.tokenMap || Object.keys(inst.tokenMap).length === 0) {
          logger.warn(`Stock scanner: No tokens found for ${stockName}, skipping`);
          continue;
        }

        // Get expiry
        const { createExpiryCalculator } = require('./utils/expiryCalculator');
        const expiryCalc = createExpiryCalculator({
          expiryType: 'monthly',
          expiryDayOfWeek: 2,
        });
        const expiry = expiryCalc.getCurrentExpiry();

        // Find ATM strike from first option token
        const tokens = Object.values(inst.tokenMap);
        const ceTokens = tokens.filter(t => t.symbol && t.symbol.includes('CE') && t.expiry === expiry);
        const peTokens = tokens.filter(t => t.symbol && t.symbol.includes('PE') && t.expiry === expiry);

        if (ceTokens.length === 0 || peTokens.length === 0) {
          logger.warn(`Stock scanner: No CE/PE tokens for ${stockName} expiry ${expiry}, skipping`);
          continue;
        }

        // FIX: Fetch actual underlying cash-market LTP
        // Look for cash market token (not option token)
        const cashToken = tokens.find(t => 
          t.instrumenttype === 'EQ' || 
          (t.symbol && !t.symbol.includes('CE') && !t.symbol.includes('PE') && t.strike === 0)
        );

        let spotPrice = null;

        if (cashToken) {
          try {
            await this.marketData._rateLimit();
            const quoteUrl = `${this.marketData.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
            const axios = require('axios');
            const resp = await axios.post(quoteUrl, {
              mode: 'LTP',
              exchangeTokens: { [cashToken.exch_seg]: [cashToken.token] },
            }, {
              headers: this.marketData._headers ? this.marketData._headers() : {
                'Authorization': `Bearer ${this.marketData.authToken || ''}`,
                'Content-Type': 'application/json',
              },
              timeout: 10000,
            });

            let fetched = null;
            const responseData = resp.data;
            if (responseData?.data?.fetched) fetched = responseData.data.fetched;
            else if (responseData?.fetched) fetched = responseData.fetched;
            else if (Array.isArray(responseData?.data)) fetched = responseData.data;
            else if (Array.isArray(responseData)) fetched = responseData;

            if (fetched && fetched.length > 0) {
              spotPrice = parseFloat(fetched[0].ltp || fetched[0].lastTradedPrice);
            }
          } catch (err) {
            logger.warn(`Stock scanner: Could not fetch cash LTP for ${stockName}: ${err.message}`);
          }
        }

        // If we couldn't get cash LTP, skip the stock rather than approximate
        if (!Number.isFinite(spotPrice)) {
          logger.warn(`Stock scanner: No cash LTP available for ${stockName}, skipping`);
          continue;
        }

        // Calculate ATM strike from actual spot price
        const strikeStep = inst.profile.strikeStep || 5;
        const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;

        const atmCE = ceTokens.find(t => Math.abs(t.strike - atmStrike) < 1);
        const atmPE = peTokens.find(t => Math.abs(t.strike - atmStrike) < 1);

        if (!atmCE || !atmPE) {
          logger.warn(`Stock scanner: No ATM options for ${stockName} at strike ${atmStrike}, skipping`);
          continue;
        }

        // Fetch ATM CE+PE LTP (lightweight quote)
        const { optionExchange } = inst.profile;
        const quoteUrl = `${this.marketData.brokerConfig.baseUrl || 'https://apiconnect.angelone.in'}/rest/secure/angelbroking/market/v1/quote/`;
        const axios = require('axios');

        await this.marketData._rateLimit();
        const resp = await axios.post(quoteUrl, {
          mode: 'LTP',
          exchangeTokens: { [optionExchange]: [atmCE.token, atmPE.token] },
        }, {
          headers: this.marketData._headers ? this.marketData._headers() : {
            'Authorization': `Bearer ${this.marketData.authToken || ''}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });

        let fetched = [];
        const responseData = resp.data;
        if (responseData && (responseData.status === true || responseData.success === true) && responseData.data) {
          fetched = responseData.data.fetched || responseData.data;
        } else if (responseData && responseData.fetched) {
          fetched = responseData.fetched;
        }

        if (!Array.isArray(fetched) || fetched.length < 2) {
          logger.warn(`Stock scanner: Could not fetch premiums for ${stockName}, skipping`);
          continue;
        }

        const ceLTP = parseFloat(fetched.find(r => r.symbolToken === atmCE.token)?.ltp) || 0;
        const peLTP = parseFloat(fetched.find(r => r.symbolToken === atmPE.token)?.ltp) || 0;

        if (ceLTP <= 0 || peLTP <= 0) {
          logger.warn(`Stock scanner: Invalid premiums for ${stockName} (CE:${ceLTP}, PE:${peLTP}), skipping`);
          continue;
        }

        // Liquidity check: spread < 8% AND premium > minPremium
        const spread = Math.abs(ceLTP - peLTP) / ((ceLTP + peLTP) / 2) * 100;
        const minPremium = 10; // STOCK_OPTION_TEMPLATE default

        if (spread < 8 && ceLTP > minPremium && peLTP > minPremium) {
          this.scanResults.push({
            stockName,
            atmStrike,
            ceLTP,
            peLTP,
            spread,
            spotPrice,
            timestamp: Date.now(),
          });

          // Activate the stock
          this.multiOrchestrator.addStock(stockName);
          this.activeStockEngines.set(stockName, { engineId: stockId, addedAt: Date.now() });
          logger.info(`Stock scanner activated: ${stockName} (spot:${spotPrice}, spread:${spread.toFixed(1)}%, CE:Rs${ceLTP}, PE:Rs${peLTP})`);
        } else {
          logger.info(`Stock scanner skipped ${stockName}: spread=${spread.toFixed(1)}%, CE=Rs${ceLTP}, PE=Rs${peLTP} (needs spread<8% & premium>${minPremium})`);
        }
      } catch (err) {
        logger.error(`Stock scan error for ${stockName}: ${err.message}`);
      }
    }
  }

  start() {
    if (this._interval) return;
    // Run immediately then every 30s
    this.scan();
    this._interval = setInterval(() => this.scan(), 30000);
    logger.info('Stock scanner started');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }
}

module.exports = { StockScanner };
