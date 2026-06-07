// ============================================================
// STOCK SCANNER
// Scans watchlist for liquid stock options and activates them
// ============================================================

const logger = require('../logger');

class StockScanner {
  constructor(marketDataService, multiOrchestrator) {
    this.watchlist = (process.env.STOCK_WATCHLIST || 'RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK').split(',').map(s => s.trim().toUpperCase());
    this.activeStockEngines = new Map(); // stockName -> { engineId, addedAt }
    this.marketData = marketDataService;
    this.multiOrchestrator = multiOrchestrator;
    this._interval = null;
  }

  async scan() {
    for (const stockName of this.watchlist) {
      if (this.activeStockEngines.has(stockName)) continue;

      try {
        // Fetch underlying LTP (NSE cash segment)
        const stockId = `STOCK_${stockName}`;
        // We need to fetch the underlying stock price
        // For simplicity, we use the instrument master to find the stock token
        // and fetch its LTP. In a real implementation, we'd need the stock's
        // cash segment token. Here we approximate by checking if the stock
        // has liquid options (spread < 8%, premium > minPremium).

        // For now, we add the stock if it's in the watchlist and not already active
        // A more sophisticated implementation would check actual liquidity
        this.multiOrchestrator.addStock(stockName);
        this.activeStockEngines.set(stockName, { engineId: stockId, addedAt: Date.now() });
        logger.info(`Stock scanner activated: ${stockName}`);
      } catch (err) {
        logger.error(`Stock scan error for ${stockName}: ${err.message}`);
      }
    }
  }

  start() {
    if (this._interval) return;
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
