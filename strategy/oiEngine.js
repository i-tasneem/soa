// ============================================================
// OI ENGINE (PHASE B)
// Existing SR: Max OI + Nearest Wall
// Buildup SR: Rolling ΔOI (build/weak)
// Next Levels: Next wall above/below
// ============================================================
let cfg = null;
try { cfg = require('../config'); } catch (_) { cfg = null; }

class OIEngine {
  constructor() {
    this.history = [];
    this.current = null;
    this.maxHistory = 30;
	this._lastPrice = null;
    this._lastPriceTs = 0;
  }

  update(chainData) {
    if (!chainData || chainData.length === 0) return null;
    const prev = this.history.length ? this.history[this.history.length - 1].data : null;
    const snapshot = this._buildSnapshot(chainData, prev);
    this.current = snapshot;
    this.history.push({ time: Date.now(), data: snapshot });
    if (this.history.length > this.maxHistory) this.history.shift();
    return snapshot;
  }

  _buildSnapshot(chainData, prevSnapshot = null) {
    let totalCEoi = 0;
    let totalPEoi = 0;
    let maxCEoi = 0;
    let maxPEoi = 0;
    let maxCEStrike = null;
    let maxPEStrike = null;

    const strikes = [];
    for (const row of chainData) {
      const ceOI = row.CE?.oi ?? 0;
      const peOI = row.PE?.oi ?? 0;
      const ceLTP = row.CE?.ltp ?? 0;
      const peLTP = row.PE?.ltp ?? 0;

      totalCEoi += ceOI;
      totalPEoi += peOI;

      if (ceOI > maxCEoi) { maxCEoi = ceOI; maxCEStrike = row.strikePrice; }
      if (peOI > maxPEoi) { maxPEoi = peOI; maxPEStrike = row.strikePrice; }

      strikes.push({
        strike: row.strikePrice,
        CE_OI: ceOI,
        PE_OI: peOI,
        CE_LTP: ceLTP,
        PE_LTP: peLTP,
        CE_Vol: row.CE?.volume ?? 0,
        PE_Vol: row.PE?.volume ?? 0,
      });
    }

    const pcr = totalCEoi > 0 ? parseFloat((totalPEoi / totalCEoi).toFixed(3)) : null;

    let pcrBias = 'NEUTRAL';
    if (pcr !== null) {
      if (pcr > 1.2) pcrBias = 'BULLISH';
      else if (pcr > 1.0) pcrBias = 'SLIGHT_BULLISH';
      else if (pcr < 0.8) pcrBias = 'BEARISH';
      else if (pcr < 1.0) pcrBias = 'SLIGHT_BEARISH';
    }

    const strikeStep = this._inferStrikeStep(strikes.map(s => s.strike));
    const deltas = this._buildStrikeDeltas(strikes, prevSnapshot?.strikes || []);
    const walls = this._buildWalls(strikes, deltas, strikeStep);

    const support = walls.supportNearest?.center ?? maxPEStrike;
    const resistance = walls.resistanceNearest?.center ?? maxCEStrike;

    return {
      strikes,
      strikeStep,
      totalCEoi,
      totalPEoi,
      pcr,
      pcrBias,
      support,
      resistance,
      maxCEoi,
      maxPEoi,
      maxResistance: maxCEStrike,
      maxSupport: maxPEStrike,
      deltas,
      walls,
      timestamp: Date.now(),
    };
  }

  _inferStrikeStep(strikes) {
    const xs = Array.from(new Set((strikes || []).map(Number).filter(Number.isFinite))).sort((a,b)=>a-b);
    if (xs.length < 2) return 100;
    const diffs = [];
    for (let i=1;i<xs.length;i++) {
      const d = xs[i]-xs[i-1];
      if (d>0) diffs.push(d);
    }
    diffs.sort((a,b)=>a-b);
    return diffs[0] || 100;
  }

  _buildStrikeDeltas(currStrikes, prevStrikes) {
    const prevMap = {};
    for (const s of prevStrikes || []) prevMap[s.strike] = s;
    return (currStrikes || []).map(s => {
      const p = prevMap[s.strike];
      return {
        strike: s.strike,
        CE_OI_Delta: p ? (s.CE_OI - (p.CE_OI ?? 0)) : 0,
        PE_OI_Delta: p ? (s.PE_OI - (p.PE_OI ?? 0)) : 0,
      };
    });
  }

  _strengthScore(oi, vol) {
    const a = Math.max(0, Number(oi) || 0);
    const b = Math.max(0, Number(vol) || 0);
    return a + 0.30 * b;
  }

  _cluster(items, step) {
    if (!items.length) return [];
    const xs = [...items].sort((a,b)=>a.strike-b.strike);
    const clusters = [];
    let cur = [xs[0]];
    for (let i=1;i<xs.length;i++) {
      if (Math.abs(xs[i].strike - xs[i-1].strike) <= step) cur.push(xs[i]);
      else { clusters.push(cur); cur = [xs[i]]; }
    }
    clusters.push(cur);

    return clusters.map(c => {
      const strikes = c.map(x=>x.strike).sort((a,b)=>a-b);
      const center = strikes[Math.floor(strikes.length/2)];
      const strength = c.reduce((s,x)=>s + (x.score||0), 0);
      const oi = c.reduce((s,x)=>s + (x.oi||0), 0);
      const vol = c.reduce((s,x)=>s + (x.vol||0), 0);
      return {
        start: strikes[0],
        end: strikes[strikes.length-1],
        center,
        strikes,
        strength: Math.round(strength),
        oi: Math.round(oi),
        vol: Math.round(vol),
      };
    }).sort((a,b)=>b.strength-a.strength);
  }

  _buildWalls(strikes, deltas, step) {
    const deltaMap = {};
    for (const d of deltas || []) deltaMap[d.strike] = d;

    const ceRank = (strikes || []).map(s => ({
      strike: s.strike,
      oi: s.CE_OI,
      vol: s.CE_Vol,
      score: this._strengthScore(s.CE_OI, s.CE_Vol),
      delta: deltaMap[s.strike]?.CE_OI_Delta ?? 0,
    })).sort((a,b)=>b.score-a.score).slice(0, 8);

    const peRank = (strikes || []).map(s => ({
      strike: s.strike,
      oi: s.PE_OI,
      vol: s.PE_Vol,
      score: this._strengthScore(s.PE_OI, s.PE_Vol),
      delta: deltaMap[s.strike]?.PE_OI_Delta ?? 0,
    })).sort((a,b)=>b.score-a.score).slice(0, 8);

    const ceWalls = this._cluster(ceRank, step);
    const peWalls = this._cluster(peRank, step);

    return {
      ceWalls,
      peWalls,
      supportNearest: null,
      resistanceNearest: null,
    };
  }

  getOIChange() {
    if (this.history.length < 2) return null;
    const prev = this.history[this.history.length - 2].data;
    const curr = this.current;
    if (!prev || !curr) return null;

    const ceDelta = curr.totalCEoi - prev.totalCEoi;
    const peDelta = curr.totalPEoi - prev.totalPEoi;

    return {
      ceDelta,
      peDelta,
      ceBuildUp: ceDelta > 0,
      peBuildUp: peDelta > 0,
      ceUnwinding: ceDelta < 0,
      peUnwinding: peDelta < 0,
    };
  }

  _pickNearestWalls(price) {
    if (!this.current?.walls) return { supportWall: null, resistanceWall: null };
    const { ceWalls, peWalls } = this.current.walls;

    const above = (ceWalls || []).filter(w => w.center >= price).sort((a,b)=>a.center-b.center);
    const below = (peWalls || []).filter(w => w.center <= price).sort((a,b)=>b.center-a.center);

    const resistanceWall = above[0] || (ceWalls || [])[0] || null;
    const supportWall = below[0] || (peWalls || [])[0] || null;

    return { supportWall, resistanceWall };
  }

  _proximityThreshold() {
    const step = this.current?.strikeStep || 100;
    return Math.max(120, Math.min(250, Math.round(step * 1.5)));
  }

  _rollingDeltas(windowN) {
    const n = Math.max(1, Math.min(windowN || 1, this.history.length));
    const slice = this.history.slice(-n).map(h => h.data).filter(Boolean);

    const ce = {};
    const pe = {};
    for (const snap of slice) {
      for (const d of (snap.deltas || [])) {
        const k = d.strike;
        ce[k] = (ce[k] || 0) + (Number(d.CE_OI_Delta) || 0);
        pe[k] = (pe[k] || 0) + (Number(d.PE_OI_Delta) || 0);
      }
    }
    return { ce, pe, window: n };
  }

  _pickExtreme(map, strikes, mode) {
    let best = null;
    for (const s of strikes) {
      const v = Number(map[s]) || 0;
      if (!best) best = { strike: s, delta: v };
      else if (mode === 'max' ? v > best.delta : v < best.delta) best = { strike: s, delta: v };
    }
    return best;
  }

  _nextWallCenter(walls, currentCenter, dir) {
    if (!Array.isArray(walls) || !walls.length || currentCenter == null) return null;
    const centers = walls.map(w => w.center).filter(x => Number.isFinite(Number(x)));
    if (!centers.length) return null;

    if (dir === 'up') {
      const above = centers.filter(c => c > currentCenter).sort((a,b)=>a-b);
      return above[0] ?? null;
    }
    const below = centers.filter(c => c < currentCenter).sort((a,b)=>b-a);
    return below[0] ?? null;
  }

  getAnalysis(price) {
    if (!this.current) return null;

    const px = Number(price);
    const change = this.getOIChange();
	
    // ---------------- PHASE 1: PCR trend, OI velocity, flow flags ----------------
    const prevSnap = this.history.length >= 2 ? this.history[this.history.length - 2].data : null;
    const prevPCR = prevSnap?.pcr ?? null;
    const curPCR = this.current.pcr ?? null;
    const pcrDelta = (curPCR != null && prevPCR != null)
      ? parseFloat((curPCR - prevPCR).toFixed(4))
      : null;

    let pcrTrend = 'FLAT';
    if (pcrDelta != null) {
      if (pcrDelta > 0.05) pcrTrend = 'RISING_FAST';
      else if (pcrDelta > 0.02) pcrTrend = 'RISING';
      else if (pcrDelta < -0.05) pcrTrend = 'FALLING_FAST';
      else if (pcrDelta < -0.02) pcrTrend = 'FALLING';
    }

    // OI velocity (ΔOI per minute) using snapshot timestamps
    let oiVelocity = null;
    if (this.history.length >= 2 && change) {
      const prevEntry = this.history[this.history.length - 2];
      const currEntry = this.history[this.history.length - 1];
      const dtMs = Math.max(1, (currEntry?.time ?? 0) - (prevEntry?.time ?? 0));
      const dtMin = dtMs / 60000;
      oiVelocity = {
        dtMin: parseFloat(dtMin.toFixed(4)),
        cePerMin: parseFloat(((change.ceDelta ?? 0) / dtMin).toFixed(2)),
        pePerMin: parseFloat(((change.peDelta ?? 0) / dtMin).toFixed(2)),
      };
    }

    // Price delta (best-effort) for buildup classification
    const prevPrice = (typeof this._lastPrice === 'number') ? this._lastPrice : null;
    const priceDelta = (prevPrice != null && Number.isFinite(px)) ? (px - prevPrice) : 0;
    if (Number.isFinite(px)) {
      this._lastPrice = px;
      this._lastPriceTs = Date.now();
    }

    // Flow flags from total OI deltas + price direction
    const ceD = change?.ceDelta ?? 0;
    const peD = change?.peDelta ?? 0;
    // Threshold for "↓↓" (big unwinding) — conservative and scales with total OI
    const ceAbsThresh = Math.max(1000, Math.round((this.current.totalCEoi ?? 0) * 0.003));
    const peAbsThresh = Math.max(1000, Math.round((this.current.totalPEoi ?? 0) * 0.003));
    const flowFlags = {
      longBuildup:  (priceDelta > 0) && (peD > 0) && (ceD < 0),
      shortBuildup: (priceDelta < 0) && (ceD > 0) && (peD < 0),
      shortCovering: (ceD < 0) && (Math.abs(ceD) >= ceAbsThresh),
      longUnwinding: (peD < 0) && (Math.abs(peD) >= peAbsThresh),
    };

    const { supportWall, resistanceWall } = this._pickNearestWalls(px);
    this.current.walls.supportNearest = supportWall;
    this.current.walls.resistanceNearest = resistanceWall;

    const support = supportWall?.center ?? this.current.support;
    const resistance = resistanceWall?.center ?? this.current.resistance;

    const thr = this._proximityThreshold();
    const nearResistance = resistance ? Math.abs(px - resistance) < thr : false;
    const nearSupport = support ? Math.abs(px - support) < thr : false;

    const isPinned = this.current.maxResistance === this.current.maxSupport;
    const nearPin = isPinned && this.current.maxResistance && Math.abs(px - this.current.maxResistance) < Math.max(200, thr);

    const oiBullish = change?.peBuildUp && change?.ceUnwinding;
    const oiBearish = change?.ceBuildUp && change?.peUnwinding;

    const rollingWindow = cfg?.oi?.rollingWindow ?? 5;
    const minOiPct = cfg?.oi?.minOiPct ?? 0.05;
    const roll = this._rollingDeltas(rollingWindow);
	
    // ---------------- PHASE 3: Wall pressure (weakening/strengthening) ----------------
    // Rolling deltas (roll.ce / roll.pe) are summed across the nearest wall's strike cluster.
    // If the sum crosses a conservative threshold, we classify the wall as weakening/strengthening.
    const _sum = (m, ks) => (ks || []).reduce((acc, k) => acc + (Number(m?.[k]) || 0), 0);

    const resistanceDelta = resistanceWall ? _sum(roll.ce, resistanceWall.strikes) : 0;
    const supportDelta = supportWall ? _sum(roll.pe, supportWall.strikes) : 0;

    // Threshold logic: max(500, 0.10% of wall OI)
    const resThr = resistanceWall ? Math.max(500, Math.round((Number(resistanceWall.oi) || 0) * 0.001)) : 0;
    const supThr = supportWall ? Math.max(500, Math.round((Number(supportWall.oi) || 0) * 0.001)) : 0;

    const wallPressure = {
      resistanceDelta,
      supportDelta,
      resistanceWeakening: resistanceWall ? (resistanceDelta <= -resThr) : false,
      resistanceStrengthening: resistanceWall ? (resistanceDelta >= resThr) : false,
      supportWeakening: supportWall ? (supportDelta <= -supThr) : false,
      supportStrengthening: supportWall ? (supportDelta >= supThr) : false,
      thresholds: { resistance: resThr, support: supThr },
    };
    const strikeInfo = {};
    let maxCE = 0, maxPE = 0;
    for (const s of (this.current.strikes || [])) {
      strikeInfo[s.strike] = s;
      if (s.CE_OI > maxCE) maxCE = s.CE_OI;
      if (s.PE_OI > maxPE) maxPE = s.PE_OI;
    }

    const allStrikes = (this.current.strikes || []).map(x => x.strike);
    const strikesBelow = allStrikes.filter(st => st <= px);
    const strikesAbove = allStrikes.filter(st => st >= px);

    const supportCandidates = strikesBelow.filter(st => (strikeInfo[st]?.PE_OI || 0) >= maxPE * minOiPct);
    const resistanceCandidates = strikesAbove.filter(st => (strikeInfo[st]?.CE_OI || 0) >= maxCE * minOiPct);

    const pePos = Object.fromEntries(Object.entries(roll.pe).filter(([_, v]) => (Number(v) || 0) > 0));
    const cePos = Object.fromEntries(Object.entries(roll.ce).filter(([_, v]) => (Number(v) || 0) > 0));

    const supportBuild = this._pickExtreme(pePos, supportCandidates, 'max');
    const resistanceBuild = this._pickExtreme(cePos, resistanceCandidates, 'max');

    const supportWeak = this._pickExtreme(roll.pe, supportCandidates, 'min');
    const resistanceWeak = this._pickExtreme(roll.ce, resistanceCandidates, 'min');

    const existingSR = {
      supportMaxOI: this.current.maxSupport,
      resistanceMaxOI: this.current.maxResistance,
      supportNearest: supportWall?.center ?? null,
      resistanceNearest: resistanceWall?.center ?? null,
      supportZone: supportWall ? { start: supportWall.start, end: supportWall.end } : null,
      resistanceZone: resistanceWall ? { start: resistanceWall.start, end: resistanceWall.end } : null,
      isPinned,
      nearPin,
    };

    const buildupSR = {
      window: roll.window,
      supportBuild: supportBuild ? { ...supportBuild, oi: strikeInfo[supportBuild.strike]?.PE_OI ?? null } : null,
      resistanceBuild: resistanceBuild ? { ...resistanceBuild, oi: strikeInfo[resistanceBuild.strike]?.CE_OI ?? null } : null,
      supportWeak: supportWeak ? { ...supportWeak, oi: strikeInfo[supportWeak.strike]?.PE_OI ?? null } : null,
      resistanceWeak: resistanceWeak ? { ...resistanceWeak, oi: strikeInfo[resistanceWeak.strike]?.CE_OI ?? null } : null,
    };

    const nextLevels = {
      nextResistance: resistanceWall ? this._nextWallCenter(this.current.walls?.ceWalls, resistanceWall.center, 'up') : null,
      nextSupport: supportWall ? this._nextWallCenter(this.current.walls?.peWalls, supportWall.center, 'down') : null,
    };
	const totalCEoi = Number(this.current.totalCEoi || 0);
    const totalPEoi = Number(this.current.totalPEoi || 0);
    const totalOI = totalCEoi + totalPEoi;

    const imbalanceScoreRaw = totalOI > 0 ? ((totalPEoi - totalCEoi) / totalOI) : 0;
    const imbalanceScore = Number(
      (Number.isFinite(imbalanceScoreRaw) ? imbalanceScoreRaw : 0).toFixed(4)
    );

    const bullThr = Number(cfg?.oi?.imbalanceBullishThreshold ?? 0.08);
    const bearThr = Number(cfg?.oi?.imbalanceBearishThreshold ?? -0.08);

    let imbalanceBias = 'NEUTRAL';
    if (imbalanceScore > bullThr) imbalanceBias = 'BULLISH';
    else if (imbalanceScore < bearThr) imbalanceBias = 'BEARISH';

    return {
      ...this.current,
      support,
      resistance,
      change,
      proximity: { nearResistance, nearSupport, threshold: thr },
      oiBullish,
      oiBearish,
      isPinned,
      nearPin,
      existingSR,
      buildupSR,
      nextLevels,
      wallPressure,

      // ---------------- PHASE 1 additions ----------------
      pcrDelta,
      pcrTrend,
      oiVelocity,
      flowFlags,
      priceDelta,
      ceBuyConfirmed: !nearPin && (this.current.pcrBias === 'BULLISH' || this.current.pcrBias === 'SLIGHT_BULLISH'),
      peBuyConfirmed: !nearPin && (this.current.pcrBias === 'BEARISH' || this.current.pcrBias === 'SLIGHT_BEARISH'),

      // ---------------- PHASE 2C additions ----------------
      imbalanceScore,
      imbalanceBias,
      imbalance: {
        score: imbalanceScore,
        bias: imbalanceBias,
        totalCEoi,
        totalPEoi
      }
    };
  }
}

module.exports = new OIEngine();
