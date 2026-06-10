// ============================================================
// REDIS CACHE MODULE — Centralized caching for market data
// Key patterns:
//   md:{instrument}:ltp              → LTP cache (TTL 10s)
//   md:{instrument}:ohlc:{tf}        → Candle data (TTL 1h)
//   oc:{instrument}:{expiry}         → Option chain (TTL 30s)
//   oc:{instrument}:atm              → ATM strike data (TTL 30s)
//   sig:{instrument}:{date}          → Signal list (TTL 24h)
//   sig:dedup:{instrument}:{type}:{hour} → Dedup key (TTL 1h)
//   sig:active:{instrument}          → Active signal (TTL 24h)
//   trade:{instrument}:active        → Active trade (TTL 24h)
//   trade:{instrument}:{date}        → Closed trades (TTL 24h)
//   sys:broker:token               → Broker token (TTL 25min)
//   sys:instrument:{id}:master     → Token map (TTL 12h)
//   sys:health                     → Health status (TTL 60s)
// ============================================================

const redis = require('redis');
const logger = require('../logger');

class RedisCache {
  constructor(config = {}) {
    this.config = {
      url: config.url || 'redis://localhost:6379',
      password: config.password || '',
      enabled: config.enabled !== false,
      ...config,
    };
    this.client = null;
    this.connected = false;
  }

  async connect() {
    if (!this.config.enabled) {
      logger.info('[Redis] Disabled');
      return false;
    }
    try {
      this.client = redis.createClient({
        url: this.config.url,
        password: this.config.password || undefined,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 500),
        },
      });

      this.client.on('error', (err) => {
        logger.error(`[Redis] ${err.message}`);
      });

      this.client.on('connect', () => {
        logger.info('[Redis] Connected');
        this.connected = true;
      });

      this.client.on('disconnect', () => {
        logger.warn('[Redis] Disconnected');
        this.connected = false;
      });

      await this.client.connect();
      return true;
    } catch (err) {
      logger.error(`[Redis] Connection failed: ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.connected = false;
    }
  }

  // ── GENERIC OPERATIONS ──────────────────────────────────────
  async get(key) {
    if (!this.connected || !this.client) return null;
    try {
      const val = await this.client.get(key);
      return val ? JSON.parse(val) : null;
    } catch (err) {
      logger.warn(`[Redis] GET ${key} failed: ${err.message}`);
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    if (!this.connected || !this.client) return false;
    try {
      if (ttlSeconds) {
        await this.client.setEx(key, ttlSeconds, JSON.stringify(value));
      } else {
        await this.client.set(key, JSON.stringify(value));
      }
      return true;
    } catch (err) {
      logger.warn(`[Redis] SET ${key} failed: ${err.message}`);
      return false;
    }
  }

  async del(key) {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.del(key);
      return true;
    } catch (err) {
      logger.warn(`[Redis] DEL ${key} failed: ${err.message}`);
      return false;
    }
  }

  async exists(key) {
    if (!this.connected || !this.client) return false;
    try {
      return await this.client.exists(key) === 1;
    } catch (err) {
      return false;
    }
  }

  async expire(key, ttlSeconds) {
    if (!this.connected || !this.client) return false;
    try {
      return await this.client.expire(key, ttlSeconds);
    } catch (err) {
      return false;
    }
  }

  // ── LIST OPERATIONS ─────────────────────────────────────────
  async lpush(key, value, ttlSeconds) {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.lPush(key, JSON.stringify(value));
      if (ttlSeconds) await this.client.expire(key, ttlSeconds);
      return true;
    } catch (err) {
      logger.warn(`[Redis] LPUSH ${key} failed: ${err.message}`);
      return false;
    }
  }

  async lrange(key, start, end) {
    if (!this.connected || !this.client) return [];
    try {
      const items = await this.client.lRange(key, start, end);
      return items.map(i => JSON.parse(i));
    } catch (err) {
      return [];
    }
  }

  async ltrim(key, start, end) {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.lTrim(key, start, end);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ── HASH OPERATIONS ─────────────────────────────────────────
  async hset(key, field, value) {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.hSet(key, field, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  async hget(key, field) {
    if (!this.connected || !this.client) return null;
    try {
      const val = await this.client.hGet(key, field);
      return val ? JSON.parse(val) : null;
    } catch (err) {
      return null;
    }
  }

  async hgetall(key) {
    if (!this.connected || !this.client) return {};
    try {
      const obj = await this.client.hGetAll(key);
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = JSON.parse(v);
      }
      return result;
    } catch (err) {
      return {};
    }
  }

  async hdel(key, field) {
    if (!this.connected || !this.client) return false;
    try {
      await this.client.hDel(key, field);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ── PATTERN DELETE (for day reset) ──────────────────────────
  async deletePattern(pattern) {
    if (!this.connected || !this.client) return 0;
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      return keys.length;
    } catch (err) {
      return 0;
    }
  }

  // ── MARKET DATA HELPERS ─────────────────────────────────────
  async getLTP(instrumentId) {
    return this.get(`md:${instrumentId}:ltp`);
  }

  async setLTP(instrumentId, data) {
    return this.set(`md:${instrumentId}:ltp`, data, 10);
  }

  async getOptionChain(instrumentId, expiry) {
    return this.get(`oc:${instrumentId}:${expiry}`);
  }

  async setOptionChain(instrumentId, expiry, data) {
    return this.set(`oc:${instrumentId}:${expiry}`, data, 30);
  }

  async getATMPremium(instrumentId) {
    return this.get(`oc:${instrumentId}:atm`);
  }

  async setATMPremium(instrumentId, data) {
    return this.set(`oc:${instrumentId}:atm`, data, 30);
  }

  // ── SIGNAL HELPERS ──────────────────────────────────────────
  async addSignal(instrumentId, date, signal) {
    const key = `sig:${instrumentId}:${date}`;
    await this.lpush(key, signal, 24 * 60 * 60);
    // Keep only last 50 signals
    await this.ltrim(key, 0, 49);
    return true;
  }

  async getSignals(instrumentId, date, limit = 50) {
    const key = `sig:${instrumentId}:${date}`;
    return this.lrange(key, 0, limit - 1);
  }

  async setDedupKey(instrumentId, type, hour) {
    const key = `sig:dedup:${instrumentId}:${type}:${hour}`;
    return this.set(key, { timestamp: Date.now() }, 3600);
  }

  async checkDedup(instrumentId, type, hour) {
    const key = `sig:dedup:${instrumentId}:${type}:${hour}`;
    return this.exists(key);
  }

  async setActiveSignal(instrumentId, signalId, signal) {
    return this.hset(`sig:active:${instrumentId}`, signalId, signal);
  }

  async getActiveSignal(instrumentId) {
    const all = await this.hgetall(`sig:active:${instrumentId}`);
    const keys = Object.keys(all);
    return keys.length > 0 ? all[keys[0]] : null;
  }

  async removeActiveSignal(instrumentId, signalId) {
    return this.hdel(`sig:active:${instrumentId}`, signalId);
  }

  // ── TRADE HELPERS ───────────────────────────────────────────
  async setActiveTrade(instrumentId, trade) {
    return this.set(`trade:${instrumentId}:active`, trade, 24 * 60 * 60);
  }

  async getActiveTrade(instrumentId) {
    return this.get(`trade:${instrumentId}:active`);
  }

  async removeActiveTrade(instrumentId) {
    return this.del(`trade:${instrumentId}:active`);
  }

  async addClosedTrade(instrumentId, date, trade) {
    const key = `trade:${instrumentId}:${date}`;
    await this.lpush(key, trade, 24 * 60 * 60);
    await this.ltrim(key, 0, 99);
    return true;
  }

  // ── BROKER TOKEN HELPERS ────────────────────────────────────
  async setBrokerToken(token, expiry) {
    return this.set('sys:broker:token', { token, expiry }, 25 * 60);
  }

  async getBrokerToken() {
    return this.get('sys:broker:token');
  }

  // ── INSTRUMENT MASTER HELPERS ───────────────────────────────
  async setTokenMap(instrumentId, tokenMap) {
    return this.set(`sys:instrument:${instrumentId}:master`, tokenMap, 12 * 60 * 60);
  }

  async getTokenMap(instrumentId) {
    return this.get(`sys:instrument:${instrumentId}:master`);
  }

  // ── HEALTH HELPERS ──────────────────────────────────────────
  async setHealth(health) {
    return this.set('sys:health', health, 60);
  }

  async getHealth() {
    return this.get('sys:health');
  }

  // ── DAY RESET ───────────────────────────────────────────────
  async dayReset() {
    logger.info('[Redis] Performing day reset...');
    const patterns = [
      'md:*',
      'oc:*',
      'sig:*',
      'trade:*',
    ];
    let total = 0;
    for (const pattern of patterns) {
      const count = await this.deletePattern(pattern);
      total += count;
    }
    logger.info(`[Redis] Day reset complete. Deleted ${total} keys.`);
    return total;
  }
}

module.exports = { RedisCache };
