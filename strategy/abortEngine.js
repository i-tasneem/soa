// ============================================================
// ABORT ENGINE
// Setup confirmation / abort logic for near-entry signals
// ============================================================

class AbortEngine {
  constructor() {
    this.setups = new Map(); // id -> {signal, price, timestamp, direction}
  }

  /**
   * Register a new SETUP signal for tracking
   * @param {Object} signal - The SETUP signal object
   * @param {number} price - Entry price (spot)
   * @param {number} timestamp - Unix ms timestamp
   * @returns {Object} The stored setup
   */
  addSetup(signal, price, timestamp) {
    const setup = {
      signal,
      price,
      timestamp,
      direction: signal.type === 'BUY_CE' ? 'UP' : 'DOWN',
    };
    this.setups.set(signal.id, setup);

    // Auto-expire after 5 minutes
    setTimeout(() => {
      this.setups.delete(signal.id);
    }, 5 * 60 * 1000);

    return setup;
  }

  /**
   * Check if any active setup should be aborted
   * @param {number} price - Current price
   * @param {number} timestamp - Current timestamp
   * @returns {Object|null} {action:'ABORT', setupId, reason} or null
   */
  checkAbort(price, timestamp) {
    for (const [id, setup] of this.setups) {
      // 3-minute TTL for abort checks
      if (timestamp - setup.timestamp > 3 * 60 * 1000) {
        this.setups.delete(id);
        continue;
      }

      const movePct = (price - setup.price) / setup.price;

      if (setup.direction === 'UP' && movePct <= -0.004) {
        this.setups.delete(id);
        return {
          action: 'ABORT',
          setupId: id,
          setup: setup.signal,
          reason: `Price reversed ${(Math.abs(movePct) * 100).toFixed(2)}% against UP setup`,
          entryPrice: setup.price,
          currentPrice: price,
        };
      }

      if (setup.direction === 'DOWN' && movePct >= 0.004) {
        this.setups.delete(id);
        return {
          action: 'ABORT',
          setupId: id,
          setup: setup.signal,
          reason: `Price reversed ${(Math.abs(movePct) * 100).toFixed(2)}% against DOWN setup`,
          entryPrice: setup.price,
          currentPrice: price,
        };
      }
    }
    return null;
  }

  /**
   * Check if any active setup should be confirmed
   * @param {number} price - Current price
   * @param {number} vwap - Current VWAP value
   * @param {number} volume - Current volume
   * @param {number} avgVolume - Average volume (20-period)
   * @param {number} timestamp - Current timestamp
   * @returns {Object|null} {action:'CONFIRM', setupId, signal} or null
   */
  checkConfirm(price, vwap, volume, avgVolume, timestamp) {
    for (const [id, setup] of this.setups) {
      // 3-minute TTL for confirm checks
      if (timestamp - setup.timestamp > 3 * 60 * 1000) {
        this.setups.delete(id);
        continue;
      }

      const direction = setup.direction;
      const vwapBreak = direction === 'UP' ? price > vwap : price < vwap;
      const volumeConfirm = avgVolume > 0 && volume > avgVolume * 1.3;

      if (vwapBreak && volumeConfirm) {
        this.setups.delete(id);
        return {
          action: 'CONFIRM',
          setupId: id,
          signal: setup.signal,
          reason: `VWAP break ${direction} with volume ${(volume / avgVolume).toFixed(2)}x avg`,
        };
      }
    }
    return null;
  }

  /**
   * Manual cleanup of expired setups
   * @param {number} timestamp - Current timestamp
   */
  cleanup(timestamp) {
    for (const [id, setup] of this.setups) {
      if (timestamp - setup.timestamp > 5 * 60 * 1000) {
        this.setups.delete(id);
      }
    }
  }

  /**
   * Get count of active setups
   */
  getActiveCount() {
    return this.setups.size;
  }
}

module.exports = AbortEngine;
