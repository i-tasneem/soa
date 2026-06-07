// ============================================================
// GREEKS CALCULATOR — Phase 2A
// Black-Scholes helper for option premium fallback + delta/gamma/theta/vega
// Safe defaults for intraday SENSEX options; no external dependency.
// ============================================================
class GreeksCalculator {
  constructor(defaults = {}) {
    this.riskFreeRate = Number(defaults.riskFreeRate ?? 0.065);
    this.defaultIv = Number(defaults.defaultIv ?? 0.18);
    this.minTteYears = Number(defaults.minTteYears ?? (1 / (365 * 24))); // 1 hour
  }

  normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  // Abramowitz-Stegun approximation; enough for trading UI / fallback estimates.
  normCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * z);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * erf);
  }

  yearsToExpiry(expiry, now = Date.now()) {
    if (!expiry) return this.minTteYears;
    let expiryDate = null;

    if (expiry instanceof Date) expiryDate = expiry;
    else if (typeof expiry === 'number') expiryDate = new Date(expiry);
    else if (typeof expiry === 'string') {
      // Handles ISO and Angel-style 06JUN2026 / 06-JUN-2026 best effort.
      const cleaned = expiry.trim().replace(/-/g, '');
      const m = cleaned.match(/^(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/i);
      if (m) {
        const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        expiryDate = new Date(Date.UTC(Number(m[3]), months[m[2].toUpperCase()], Number(m[1]), 10, 0, 0));
      } else {
        expiryDate = new Date(expiry);
      }
    }

    if (!expiryDate || Number.isNaN(expiryDate.getTime())) return this.minTteYears;
    const diffMs = expiryDate.getTime() - now;
    return Math.max(this.minTteYears, diffMs / (365 * 24 * 60 * 60 * 1000));
  }

  calculate({ spot, strike, type, expiry, iv, rate, now }) {
    const S = Number(spot);
    const K = Number(strike);
    const sigma = Math.max(0.01, Number(iv ?? this.defaultIv));
    const r = Number(rate ?? this.riskFreeRate);
    const T = this.yearsToExpiry(expiry, now ?? Date.now());
    const side = String(type || '').toUpperCase().includes('PE') || String(type || '').toUpperCase() === 'PUT' ? 'PE' : 'CE';

    if (!Number.isFinite(S) || !Number.isFinite(K) || S <= 0 || K <= 0) {
      return { premium: null, delta: null, gamma: null, theta: null, vega: null, tteYears: T, iv: sigma };
    }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const Nd1 = this.normCdf(d1);
    const Nd2 = this.normCdf(d2);
    const discount = Math.exp(-r * T);

    const call = S * Nd1 - K * discount * Nd2;
    const put = K * discount * this.normCdf(-d2) - S * this.normCdf(-d1);
    const delta = side === 'CE' ? Nd1 : Nd1 - 1;
    const gamma = this.normPdf(d1) / (S * sigma * sqrtT);
    const vega = (S * this.normPdf(d1) * sqrtT) / 100;
    const thetaCall = (-(S * this.normPdf(d1) * sigma) / (2 * sqrtT) - r * K * discount * Nd2) / 365;
    const thetaPut = (-(S * this.normPdf(d1) * sigma) / (2 * sqrtT) + r * K * discount * this.normCdf(-d2)) / 365;

    return {
      premium: Number(Math.max(0.05, side === 'CE' ? call : put).toFixed(2)),
      delta: Number(delta.toFixed(4)),
      gamma: Number(gamma.toFixed(6)),
      theta: Number((side === 'CE' ? thetaCall : thetaPut).toFixed(4)),
      vega: Number(vega.toFixed(4)),
      d1: Number(d1.toFixed(4)),
      d2: Number(d2.toFixed(4)),
      tteYears: Number(T.toFixed(8)),
      iv: sigma,
    };
  }

  estimatePremiumFromMove({ entryPremium, entrySpot, currentSpot, type, delta }) {
    const ep = Number(entryPremium);
    const es = Number(entrySpot);
    const cs = Number(currentSpot);
    const d = Number(delta ?? 0.5);
    if (![ep, es, cs].every(Number.isFinite)) return null;
    const direction = String(type).includes('PE') ? -1 : 1;
    return Number(Math.max(0.05, ep + ((cs - es) * d * direction)).toFixed(2));
  }
}

module.exports = GreeksCalculator;
module.exports.instance = new GreeksCalculator();
