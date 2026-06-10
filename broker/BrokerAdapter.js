// ============================================================
// BROKER ADAPTER — Abstract Base Class
// Defines the contract every broker implementation must satisfy.
// Strategy layer must NOT know broker details.
// ============================================================

class BrokerAdapter {
  constructor(config = {}) {
    this.config = config;
    this.name = 'abstract';
    this.authToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }

  // ── AUTHENTICATION ─────────────────────────────────────────
  async authenticate() {
    throw new Error('authenticate() must be implemented by subclass');
  }

  async refreshAuthToken() {
    throw new Error('refreshAuthToken() must be implemented by subclass');
  }

  isTokenValid() {
    return !!this.authToken && Date.now() < this.tokenExpiry - 300000; // 5min buffer
  }

  // ── MARKET DATA ────────────────────────────────────────────
  async getSpotLTP(instrumentId, exchange, token) {
    throw new Error('getSpotLTP() must be implemented by subclass');
  }

  async getQuotes(exchangeTokens, mode = 'LTP') {
    // exchangeTokens: { [exchange]: [token1, token2, ...] }
    throw new Error('getQuotes() must be implemented by subclass');
  }

  async getOptionChain(instrumentId, spotPrice, expiry, tokenMap, profile) {
    // Returns: { chainData: [{strikePrice, CE, PE}], premiums: {ce, pe, atmStrike} }
    throw new Error('getOptionChain() must be implemented by subclass');
  }

  async getHistoricalData(instrumentId, exchange, token, interval, from, to) {
    throw new Error('getHistoricalData() must be implemented by subclass');
  }

  // ── INSTRUMENT MASTER ───────────────────────────────────────
  async getInstrumentMaster() {
    throw new Error('getInstrumentMaster() must be implemented by subclass');
  }

  // ── WEBSOCKET / LIVE FEED ───────────────────────────────────
  async subscribeLiveFeed(tokens, onTick) {
    // Optional: return unsubscribe function
    throw new Error('subscribeLiveFeed() must be implemented by subclass');
  }

  // ── HELPERS ────────────────────────────────────────────────
  getHeaders() {
    return {};
  }

  getBaseUrl() {
    return this.config.baseUrl || '';
  }

  // Rate limiter hook (subclass can override)
  async rateLimit() {
    // noop by default
  }

  // Circuit breaker hook
  onError(err) {
    // noop by default
  }
}

module.exports = { BrokerAdapter };
