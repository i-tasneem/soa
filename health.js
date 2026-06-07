// ============================================================
//  Health Monitoring Module
// ============================================================

const logger = require('./logger');

class HealthMonitor {
  constructor() {
    this.serverState = {
      authToken: null,
      wsClients: 0,
      lastSensex: null,
      startTime: new Date(),
      lastUpdate: new Date(),
      optionChainUpdateCount: 0,
      crestfullUpdateCount: 0,
      lastApiLatMs: null,
      marketOpen: null,
    };

    this.snapshots = [];
    this.maxSnapshots = 144; // 24h @ 10 min
    this._timer = null;
  }

  setServerState(state) {
    this.serverState = {
      ...this.serverState,
      ...state,
      lastUpdate: new Date(),
    };
  }

  buildHealthPayload() {
    const now = new Date();
    const uptimeMs = now - this.serverState.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    let status = 'unhealthy';
    let reason = 'No auth token';

    if (this.serverState.authToken && this.serverState.lastSensex != null) {
      status = 'healthy';
      reason = 'Auth active and market data received';
    } else if (this.serverState.authToken) {
      status = 'degraded';
      reason = 'Auth active but no latest market price';
    }

    return {
      status,
      reason,
      uptimeSeconds,
      timestamp: now.toISOString(),
      serverState: {
        authToken: !!this.serverState.authToken,
        wsClients: this.serverState.wsClients,
        lastSensex: this.serverState.lastSensex,
        lastApiLatMs: this.serverState.lastApiLatMs ?? null,
        optionChainUpdateCount: this.serverState.optionChainUpdateCount,
        crestfullUpdateCount: this.serverState.crestfullUpdateCount,
        marketOpen: this.serverState.marketOpen,
        lastUpdate: this.serverState.lastUpdate,
        startTime: this.serverState.startTime,
      },
    };
  }

  takeSnapshot() {
    const snapshot = {
      timestamp: new Date(),
      ...this.serverState,
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    return snapshot;
  }

  startPeriodicSnapshots(interval = 10 * 60 * 1000) {
    if (this._timer) clearInterval(this._timer);

    logger.info('🏥 Health monitor: Starting periodic snapshots', { intervalMs: interval });

    this._timer = setInterval(() => {
      try {
        this.takeSnapshot();
      } catch (err) {
        logger.error('❌ Health snapshot failed', { error: err.message });
      }
    }, interval);
  }

  getRecentSnapshots(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.snapshots.filter(s => s.timestamp > cutoff);
  }

  getHealthStats() {
    const recent = this.getRecentSnapshots(1);

    if (recent.length === 0) {
      return {
        avgClients: 0,
        maxClients: 0,
        healthSnapshot: this.buildHealthPayload(),
      };
    }

    const clientCounts = recent.map(s => Number(s.wsClients) || 0);
    const avgClients = clientCounts.reduce((a, b) => a + b, 0) / clientCounts.length;
    const maxClients = Math.max(...clientCounts);

    return {
      avgClients: Number(avgClients.toFixed(2)),
      maxClients,
      healthSnapshot: this.buildHealthPayload(),
    };
  }

  reset() {
    this.serverState = {
      authToken: null,
      wsClients: 0,
      lastSensex: null,
      startTime: new Date(),
      lastUpdate: new Date(),
      optionChainUpdateCount: 0,
      crestfullUpdateCount: 0,
      lastApiLatMs: null,
      marketOpen: null,
    };

    this.snapshots = [];
  }
}

module.exports = new HealthMonitor();