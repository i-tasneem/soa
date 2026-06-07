// ============================================================
// TEST: Signal Engine — Institutional Grade A
// 10 scenarios covering all DNA filters and scoring paths
// Run: node test-signal-engine.js
// ============================================================

const SignalEngine = require('./strategy/signalEngine');
const RegimeDetector = require('./strategy/regimeDetector');
const AbortEngine = require('./strategy/abortEngine');
const dnaProfiles = require('./strategy/dna/instrumentProfiles');

// Helper to build mock indicators
function makeIndicators(opts = {}) {
  return {
    price: opts.price || 75000,
    ema: {
      ema5: opts.ema5 || 74950,
      ema9: opts.ema9 || 74900,
      ema15: opts.ema15 || 74850,
      ema50: opts.ema50 || 74500,
      ema9_15m: opts.ema9_15m || 74800,
      ema15_15m: opts.ema15_15m || 74750,
    },
    vwap: { vwap: opts.vwap || 74900 },
    bb: {
      '5m': {
        upper: opts.bbUpper || 75100,
        lower: opts.bbLower || 74700,
        middle: opts.bbMid || 74900,
        bandwidth: opts.bbBW || 2.5,
        squeeze: opts.bbSqueeze || false,
      }
    },
    bias: {
      bullishEMA: opts.bullishEMA !== undefined ? opts.bullishEMA : true,
      bearishEMA: opts.bearishEMA !== undefined ? opts.bearishEMA : false,
      aboveVWAP: opts.aboveVWAP !== undefined ? opts.aboveVWAP : true,
      belowVWAP: opts.belowVWAP !== undefined ? opts.belowVWAP : false,
      htfBullish: opts.htfBullish !== undefined ? opts.htfBullish : true,
      htfBearish: opts.htfBearish !== undefined ? opts.htfBearish : false,
    },
    momentum: {
      bullMomentum: opts.bullMomentum !== undefined ? opts.bullMomentum : true,
      bearMomentum: opts.bearMomentum !== undefined ? opts.bearMomentum : false,
    },
    candle: {
      last: {
        bullish: opts.candleBullish !== undefined ? opts.candleBullish : true,
        bearish: opts.candleBearish !== undefined ? opts.candleBearish : false,
        bodyPct: opts.bodyPct || 65,
        isStrong: opts.isStrong !== undefined ? opts.isStrong : true,
        isDoji: opts.isDoji || false,
        isHammer: opts.isHammer || false,
        isShootingStar: opts.isShootingStar || false,
      }
    },
    breakout: {
      priceAboveBB: opts.priceAboveBB || false,
      priceBelowBB: opts.priceBelowBB || false,
    },
    atr14: opts.atr14 || 30,
    volume: {
      current: opts.volumeCurrent || 1500,
      avg20: opts.volumeAvg20 || 1000,
    },
  };
}

function makeMarketState(state = 'TRENDING_BULLISH') {
  return { state, bullScore: 5, bearScore: 1, reasons: ['TEST'] };
}

function makeOIAnalysis(opts = {}) {
  return {
    stale: false,
    premiumsStale: false,
    nearPin: opts.nearPin || false,
    walls: {
      resistanceNearest: opts.resistanceNearest || { center: 75100 },
      supportNearest: opts.supportNearest || { center: 74700 },
    },
    wallPressure: {
      resistanceWeakening: opts.resistanceWeakening || false,
      supportWeakening: opts.supportWeakening || false,
    },
    proximity: {
      nearResistance: opts.nearResistance || false,
      nearSupport: opts.nearSupport || false,
    },
    ceBuyConfirmed: opts.ceBuyConfirmed !== undefined ? opts.ceBuyConfirmed : true,
    peBuyConfirmed: opts.peBuyConfirmed !== undefined ? opts.peBuyConfirmed : false,
  };
}

function makePremiums(ce = 120, pe = 110) {
  return { ce, pe };
}

function makeMeta(opts = {}) {
  return {
    exec: {
      ce: { strike: 75000, token: 'CE1', expiry: opts.ceExpiry || '18JUN2026' },
      pe: { strike: 75000, token: 'PE1', expiry: opts.peExpiry || '18JUN2026' },
    },
    atm: { strike: 75000, call: 120, put: 110 },
  };
}

// Reset engine before each test
function reset() {
  SignalEngine.resetDay();
}

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${name}`);
    failed++;
  }
}

// ============================================================
// SCENARIO 1: Normal bullish → CONFIRMED
// ============================================================
reset();
const s1 = SignalEngine.evaluate(
  makeIndicators({ bullishEMA: true, aboveVWAP: true, htfBullish: true, bodyPct: 70, volumeCurrent: 2000 }),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis({ resistanceWeakening: true, nearResistance: true }),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 1: Normal bullish → CONFIRMED', s1 && s1.signalStage === 'CONFIRMED' && s1.type === 'BUY_CE');

// ============================================================
// SCENARIO 2: Normal bearish → CONFIRMED
// ============================================================
reset();
const s2 = SignalEngine.evaluate(
  makeIndicators({
    bullishEMA: false, bearishEMA: true,
    aboveVWAP: false, belowVWAP: true,
    htfBullish: false, htfBearish: true,
    candleBullish: false, candleBearish: true,
    bodyPct: 70, ema5: 75050, ema9: 75100, ema15: 75150,
    price: 74800, vwap: 74900,  // price below vwap for bearish
    ema9_15m: 74700, ema15_15m: 74750,  // ema9 < ema15 for htf bearish
  }),
  makeMarketState('TRENDING_BEARISH'),
  makeOIAnalysis({ supportWeakening: true, nearSupport: true, ceBuyConfirmed: false, peBuyConfirmed: true }),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 2: Normal bearish → CONFIRMED', s2 && s2.signalStage === 'CONFIRMED' && s2.type === 'BUY_PE');

// ============================================================
// SCENARIO 3: Extreme regime → null
// ============================================================
reset();
const s3 = SignalEngine.evaluate(
  makeIndicators(),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis(),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(100, 25, 95) // EXTREME
);
assert('Scenario 3: Extreme regime → null', s3 === null);

// ============================================================
// SCENARIO 4: Dead regime → null
// ============================================================
reset();
const s4 = SignalEngine.evaluate(
  makeIndicators(),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis(),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(2, 25) // DEAD
);
assert('Scenario 4: Dead regime → null', s4 === null);

// ============================================================
// SCENARIO 5: Gamma trap (expiry < 3h) → null
// ============================================================
reset();
const nearExpiry = new Date();
nearExpiry.setHours(nearExpiry.getHours() + 2);
const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const nearExpiryStr = `${String(nearExpiry.getDate()).padStart(2,'0')}${monthNames[nearExpiry.getMonth()]}${nearExpiry.getFullYear()}`;
const s5 = SignalEngine.evaluate(
  makeIndicators(),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis(),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(),
  makeMeta({ ceExpiry: nearExpiryStr }),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 5: Gamma trap → null', s5 === null);

// ============================================================
// SCENARIO 6: Lunch ban → null
// ============================================================
reset();
const lunchTime = new Date('2026-06-08T12:30:00+05:30').getTime();
const s6 = SignalEngine.evaluate(
  makeIndicators(),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis(),
  lunchTime,
  makePremiums(),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 6: Lunch ban → null', s6 === null);

// ============================================================
// SCENARIO 7: Setup escalation (price breaks VWAP + volume) → CONFIRMED
// ============================================================
reset();
const abortEngine = new AbortEngine();
const setupIndicators = makeIndicators({
  bullishEMA: true, aboveVWAP: true, htfBullish: true,
  bodyPct: 50, volumeCurrent: 1100, priceAboveBB: false
});
const setupOI = makeOIAnalysis({ resistanceWeakening: false, nearResistance: false });
const setupSignal = SignalEngine.evaluate(
  setupIndicators,
  makeMarketState('TRENDING_BULLISH'),
  setupOI,
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 7a: Setup created', setupSignal && setupSignal.signalStage === 'SETUP');
if (setupSignal) {
  abortEngine.addSetup(setupSignal, setupIndicators.price, Date.now());
  // Simulate price breaking above VWAP with volume spike
  const confirm = abortEngine.checkConfirm(
    setupIndicators.vwap.vwap + 50,
    setupIndicators.vwap.vwap,
    1500, // 1.5x avg
    1000,
    Date.now()
  );
  assert('Scenario 7b: Setup escalation → CONFIRMED', confirm && confirm.action === 'CONFIRM');
}

// ============================================================
// SCENARIO 8: Setup abort (price reverses 0.5%) → ABORT
// ============================================================
reset();
const abortEngine2 = new AbortEngine();
const setup2 = SignalEngine.evaluate(
  makeIndicators({ bullishEMA: true, aboveVWAP: true, htfBullish: true, bodyPct: 50, priceAboveBB: false }),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis(),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 8a: Setup created for abort', setup2 && setup2.signalStage === 'SETUP');
if (setup2) {
  abortEngine2.addSetup(setup2, setup2.price, Date.now());
  const abortPrice = setup2.price * 0.995; // 0.5% down
  const abort = abortEngine2.checkAbort(abortPrice, Date.now());
  assert('Scenario 8b: Setup abort triggered', abort && abort.action === 'ABORT');
}

// ============================================================
// SCENARIO 9: Near resistance penalty → SETUP (score ~0.60)
// ============================================================
reset();
const s9 = SignalEngine.evaluate(
  makeIndicators({
    bullishEMA: true, aboveVWAP: true, htfBullish: true,
    bodyPct: 15, volumeCurrent: 1050, priceAboveBB: false
  }),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis({ nearResistance: true, resistanceWeakening: false }),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 9: Near resistance → SETUP (~0.60)', s9 && s9.signalStage === 'SETUP' && s9.finalScore >= 0.55 && s9.finalScore < 0.72);

// ============================================================
// SCENARIO 10: Volume spike boost → CONFIRMED
// ============================================================
reset();
const s10 = SignalEngine.evaluate(
  makeIndicators({
    bullishEMA: true, aboveVWAP: true, htfBullish: true,
    bodyPct: 65, volumeCurrent: 1800
  }),
  makeMarketState('TRENDING_BULLISH'),
  makeOIAnalysis({ resistanceWeakening: true, nearResistance: true }),
  new Date('2026-06-08T10:00:00+05:30').getTime(),
  makePremiums(120, 110),
  makeMeta(),
  dnaProfiles.SENSEX,
  RegimeDetector.classifyRegime(30, 25)
);
assert('Scenario 10: Volume spike → CONFIRMED', s10 && s10.signalStage === 'CONFIRMED');

// ============================================================
// SUMMARY
// ============================================================
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
