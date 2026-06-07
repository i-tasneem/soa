// ============================================================
// DATA FRESHNESS — Centralized cache/freshness manager
// ============================================================
const EventEmitter = require('events');
const config = require('../config');

class DataFreshness extends EventEmitter {
  constructor(feedConfig = config.feeds || {}) {
    super();
    this.feedConfig = feedConfig;
    this.feeds = new Map();
    this.lastWarningAt = new Map();
    this.warningCooldownMs = 15000;
  }

  update(feedName, timestamp = Date.now(), data = null) {
    const ts = Number(timestamp) || Date.now();
    const previous = this.feeds.get(feedName);
    const intervalMs = previous?.timestamp ? ts - previous.timestamp : null;
    const cfg = this.feedConfig[feedName] || {};
    const record = {
      feedName,
      timestamp: ts,
      isoTime: new Date(ts).toISOString(),
      data,
      intervalMs,
      minFrequencyMs: cfg.minFrequencyMs ?? null,
      maxStaleMs: cfg.maxStaleMs ?? null,
      description: cfg.description || feedName,
    };
    this.feeds.set(feedName, record);
    if (intervalMs != null && cfg.minFrequencyMs && intervalMs > cfg.minFrequencyMs * 2) {
      this._warn(feedName, `Feed ${feedName} slower than SLA`, { intervalMs, minFrequencyMs: cfg.minFrequencyMs });
      this.emit('frequency.slow', { feedName, intervalMs, minFrequencyMs: cfg.minFrequencyMs });
    }
    this.emit('feed.update', record);
    return record;
  }

  getAge(feedName, now = Date.now()) {
    const record = this.feeds.get(feedName);
    if (!record?.timestamp) return Infinity;
    return Math.max(0, now - record.timestamp);
  }

  isStale(feedName, maxAgeMs = null, now = Date.now()) {
    const cfg = this.feedConfig[feedName] || {};
    const limit = Number(maxAgeMs ?? cfg.maxStaleMs ?? 0);
    if (!limit) return false;
    return this.getAge(feedName, now) > limit;
  }

  getStaleReport(now = Date.now()) {
    const names = new Set([...Object.keys(this.feedConfig || {}), ...this.feeds.keys()]);
    const report = {};
    for (const name of names) {
      const record = this.feeds.get(name);
      const cfg = this.feedConfig[name] || {};
      const ageMs = record?.timestamp ? Math.max(0, now - record.timestamp) : null;
      const maxStaleMs = cfg.maxStaleMs ?? record?.maxStaleMs ?? null;
      report[name] = {
        ageMs,
        isStale: ageMs == null ? true : (maxStaleMs ? ageMs > maxStaleMs : false),
        lastUpdated: record?.isoTime || null,
        intervalMs: record?.intervalMs ?? null,
        minFrequencyMs: cfg.minFrequencyMs ?? null,
        maxStaleMs,
        description: cfg.description || name,
      };
    }
    return report;
  }

  subscribeToChanges(callback) {
    if (typeof callback !== 'function') return () => {};
    this.on('feed.update', callback);
    this.on('frequency.slow', callback);
    return () => {
      this.off('feed.update', callback);
      this.off('frequency.slow', callback);
    };
  }

  checkAll(now = Date.now()) {
    const report = this.getStaleReport(now);
    for (const [feedName, item] of Object.entries(report)) {
      if (item.isStale) {
        this._warn(feedName, `Feed ${feedName} stale`, item);
        this.emit('feed.stale', { feedName, ...item });
      }
    }
    return report;
  }

  _warn(feedName, message, details = {}) {
    const now = Date.now();
    const last = this.lastWarningAt.get(feedName) || 0;
    if (now - last < this.warningCooldownMs) return;
    this.lastWarningAt.set(feedName, now);
    console.warn(`⚠️ ${message}`, details);
  }
}

module.exports = DataFreshness;
module.exports.instance = new DataFreshness();
