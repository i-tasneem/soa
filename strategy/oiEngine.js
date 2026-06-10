// ============================================================
// OI ENGINE v7 — Wall Fix
// Changes from v6:
// 1. _buildWalls now properly populates supportNearest/resistanceNearest
// 2. Cluster-based walls (not single-strike fallback)
// 3. Distance threshold added to wall selection
// 4. Pin detection improved with wall proximity check
// STRATEGY LOGIC UNCHANGED — only wall calculation fixed
// ============================================================

const logger = require('../logger');

class OIEngine {
  constructor() {
    this.data = null;
    this.lastUpdate = 0;
    this.history = [];
    this.maxHistory = 50;
    this.pcrHistory = [];
    this.maxPcrHistory = 20;
  }

  update(chainData) {
    if (!chainData || !Array.isArray(chainData) || chainData.length === 0) {
      logger.warn('[OIEngine] Invalid chain data');
      return;
    }
    this.data = chainData;
    this.lastUpdate = Date.now();
    this._updateHistory();
  }

  _updateHistory() {
    if (!this.data) return;
    const analysis = this._buildSnapshot(this.data);
    this.history.push({ ...analysis, timestamp: Date.now() });
    if (this.history.length > this.maxHistory) this.history.shift();
    this.pcrHistory.push(analysis.pcr);
    if (this.pcrHistory.length > this.maxPcrHistory) this.pcrHistory.shift();
  }

  _buildSnapshot(chainData) {
    let totalCEoi = 0, totalPEoi = 0, totalCEvol = 0, totalPEvol = 0;
    let maxCEoi = 0, maxPEoi = 0, maxCEStrike = 0, maxPEStrike = 0;
    const ceOis = [], peOis = [], strikes = [];

    for (const row of chainData) {
      const strike = row.strikePrice;
      strikes.push(strike);
      if (row.CE) {
        totalCEoi += row.CE.oi || 0;
        totalCEvol += row.CE.volume || 0;
        ceOis.push({ strike, oi: row.CE.oi || 0 });
        if ((row.CE.oi || 0) > maxCEoi) {
          maxCEoi = row.CE.oi || 0;
          maxCEStrike = strike;
        }
      }
      if (row.PE) {
        totalPEoi += row.PE.oi || 0;
        totalPEvol += row.PE.volume || 0;
        peOis.push({ strike, oi: row.PE.oi || 0 });
        if ((row.PE.oi || 0) > maxPEoi) {
          maxPEoi = row.PE.oi || 0;
          maxPEStrike = strike;
        }
      }
    }

    const pcr = totalCEoi > 0 ? totalPEoi / totalCEoi : 1;
    const totalOi = totalCEoi + totalPEoi;
    const ceOiPct = totalOi > 0 ? (totalCEoi / totalOi) * 100 : 50;
    const peOiPct = totalOi > 0 ? (totalPEoi / totalOi) * 100 : 50;

    // Build walls using cluster detection
    const walls = this._buildWalls(ceOis, peOis, strikes);

    // Use wall clusters, not single-strike fallback
    const support = walls.supportNearest?.center ?? maxPEStrike;
    const resistance = walls.resistanceNearest?.center ?? maxCEStrike;

    return {
      pcr,
      totalCEoi,
      totalPEoi,
      totalCEvol,
      totalPEvol,
      maxCEoi,
      maxPEoi,
      maxCEStrike,
      maxPEStrike,
      ceOiPct,
      peOiPct,
      support,
      resistance,
      supportNearest: walls.supportNearest,
      resistanceNearest: walls.resistanceNearest,
      ceWalls: walls.ceWalls,
      peWalls: walls.peWalls,
      isPinned: walls.isPinned,
      timestamp: Date.now(),
    };
  }

  _buildWalls(ceOis, peOis, strikes) {
    // Sort by OI descending
    const sortedCE = [...ceOis].sort((a, b) => b.oi - a.oi);
    const sortedPE = [...peOis].sort((a, b) => b.oi - a.oi);

    // Find clusters: strikes within 2 steps of each other with high OI
    const strikeStep = strikes.length > 1 ? Math.abs(strikes[1] - strikes[0]) : 50;
    const clusterRadius = strikeStep * 2; // 2 strikes radius

    const ceWalls = this._findClusters(sortedCE, clusterRadius, 3); // top 3 clusters
    const peWalls = this._findClusters(sortedPE, clusterRadius, 3);

    // Determine nearest walls to current price (will be set in getAnalysis)
    // For now, return the strongest wall as nearest
    const supportNearest = peWalls.length > 0 ? peWalls[0] : null;
    const resistanceNearest = ceWalls.length > 0 ? ceWalls[0] : null;

    // Pin detection: if strongest CE and PE walls overlap or are very close
    const isPinned = supportNearest && resistanceNearest && 
      Math.abs(supportNearest.center - resistanceNearest.center) <= clusterRadius;

    return { ceWalls, peWalls, supportNearest, resistanceNearest, isPinned };
  }

  _findClusters(sortedOi, radius, maxClusters) {
    const clusters = [];
    const used = new Set();

    for (const item of sortedOi) {
      if (used.has(item.strike)) continue;

      const cluster = {
        strikes: [item.strike],
        totalOi: item.oi,
        center: item.strike,
        maxOi: item.oi,
      };
      used.add(item.strike);

      for (const other of sortedOi) {
        if (used.has(other.strike)) continue;
        if (Math.abs(other.strike - item.strike) <= radius) {
          cluster.strikes.push(other.strike);
          cluster.totalOi += other.oi;
          if (other.oi > cluster.maxOi) cluster.maxOi = other.oi;
          used.add(other.strike);
        }
      }

      // Recalculate center as weighted average
      const totalWeight = cluster.strikes.reduce((sum, s) => {
        const oi = sortedOi.find(x => x.strike === s)?.oi || 0;
        return sum + oi * s;
      }, 0);
      const totalOi = cluster.strikes.reduce((sum, s) => {
        return sum + (sortedOi.find(x => x.strike === s)?.oi || 0);
      }, 0);
      cluster.center = totalOi > 0 ? Math.round(totalWeight / totalOi) : item.strike;

      clusters.push(cluster);
      if (clusters.length >= maxClusters) break;
    }

    return clusters;
  }

  getAnalysis(spotPrice) {
    if (!this.data || this.data.length === 0) {
      return {
        pcr: 1, pcrBias: 'NEUTRAL', oiBullish: false, oiBearish: false,
        support: null, resistance: null, supportNearest: null, resistanceNearest: null,
        isPinned: false, wallPressure: 'NEUTRAL', imbalance: 0,
        nearSupport: false, nearResistance: false,
        ceBuildup: false, peBuildup: false, ceUnwind: false, peUnwind: false,
        longBuildup: false, shortBuildup: false, shortCovering: false, longUnwinding: false,
        timestamp: Date.now(),
      };
    }

    const snapshot = this._buildSnapshot(this.data);
    const prev = this.history.length > 1 ? this.history[this.history.length - 2] : null;

    const pcr = snapshot.pcr;
    let pcrBias = 'NEUTRAL';
    if (pcr > 1.2) pcrBias = 'BULLISH';
    else if (pcr > 1.0) pcrBias = 'SLIGHT_BULLISH';
    else if (pcr < 0.8) pcrBias = 'BEARISH';
    else if (pcr < 1.0) pcrBias = 'SLIGHT_BEARISH';

    const ceOiChange = prev ? snapshot.totalCEoi - prev.totalCEoi : 0;
    const peOiChange = prev ? snapshot.totalPEoi - prev.totalPEoi : 0;
    const ceVolChange = prev ? snapshot.totalCEvol - prev.totalCEvol : 0;
    const peVolChange = prev ? snapshot.totalPEvol - prev.totalPEvol : 0;

    const oiBullish = peOiChange > 0 && ceOiChange < 0;
    const oiBearish = ceOiChange > 0 && peOiChange < 0;

    const longBuildup = peOiChange > 0 && peVolChange > 0;
    const shortBuildup = ceOiChange > 0 && ceVolChange > 0;
    const shortCovering = peOiChange < 0 && peVolChange > 0;
    const longUnwinding = ceOiChange < 0 && ceVolChange > 0;

    const ceBuildup = ceOiChange > 0 && ceVolChange > 0;
    const peBuildup = peOiChange > 0 && peVolChange > 0;
    const ceUnwind = ceOiChange < 0 && ceVolChange > 0;
    const peUnwind = peOiChange < 0 && peVolChange > 0;

    // Pick nearest walls with distance threshold
    const { supportNearest, resistanceNearest } = this._pickNearestWalls(snapshot, spotPrice);

    const support = supportNearest?.center ?? snapshot.maxPEStrike;
    const resistance = resistanceNearest?.center ?? snapshot.maxCEStrike;

    const isPinned = supportNearest && resistanceNearest && 
      Math.abs(supportNearest.center - resistanceNearest.center) <= 100; // 2 strikes for NIFTY

    let wallPressure = 'NEUTRAL';
    if (supportNearest && resistanceNearest) {
      const supportDist = Math.abs(spotPrice - supportNearest.center);
      const resistanceDist = Math.abs(spotPrice - resistanceNearest.center);
      if (supportDist < resistanceDist && peOiChange > 0) wallPressure = 'BULLISH';
      else if (resistanceDist < supportDist && ceOiChange > 0) wallPressure = 'BEARISH';
    }

    const imbalance = snapshot.totalOi > 0 ? (snapshot.totalPEoi - snapshot.totalCEoi) / snapshot.totalOi : 0;

    const strikeStep = this.data.length > 1 ? Math.abs(this.data[1].strikePrice - this.data[0].strikePrice) : 50;
    const threshold = Math.max(120, Math.min(250, strikeStep * 1.5));
    const nearSupport = support ? Math.abs(spotPrice - support) < threshold : false;
    const nearResistance = resistance ? Math.abs(spotPrice - resistance) < threshold : false;

    return {
      pcr, pcrBias, oiBullish, oiBearish,
      support, resistance, supportNearest, resistanceNearest,
      isPinned, wallPressure, imbalance,
      nearSupport, nearResistance,
      ceBuildup, peBuildup, ceUnwind, peUnwind,
      longBuildup, shortBuildup, shortCovering, longUnwinding,
      timestamp: Date.now(),
    };
  }

  _pickNearestWalls(snapshot, spotPrice) {
    const { ceWalls, peWalls } = snapshot;

    let supportNearest = null;
    let resistanceNearest = null;
    let minSupportDist = Infinity;
    let minResistanceDist = Infinity;

    // Distance threshold: max 5 strikes away
    const maxDist = 250; // NIFTY: 5 * 50

    for (const wall of peWalls || []) {
      const dist = Math.abs(spotPrice - wall.center);
      if (dist < minSupportDist && dist <= maxDist) {
        minSupportDist = dist;
        supportNearest = wall;
      }
    }

    for (const wall of ceWalls || []) {
      const dist = Math.abs(spotPrice - wall.center);
      if (dist < minResistanceDist && dist <= maxDist) {
        minResistanceDist = dist;
        resistanceNearest = wall;
      }
    }

    return { supportNearest, resistanceNearest };
  }

  getHistory() {
    return [...this.history];
  }

  getPCRHistory() {
    return [...this.pcrHistory];
  }
}

module.exports = { OIEngine };
