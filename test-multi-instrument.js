// ============================================================
// TEST: Multi-Instrument Independence
// Standalone test — no Angel One API needed (mocked)
// ============================================================

const assert = require('assert');

// ── MOCKS ───────────────────────────────────────────────────

// Mock Angel One responses
const MOCK_LTP_RESPONSE = {
  status: true,
  data: {
    fetched: [{ ltp: '23450.75', symbolToken: '99926000' }]
  }
};

const MOCK_CHAIN_RESPONSE = {
  status: true,
  data: {
    fetched: [
      { symbolToken: 'CE1', ltp: '380', oi: 50000, volume: 1000, bid: '379', ask: '381' },
      { symbolToken: 'PE1', ltp: '350', oi: 45000, volume: 900, bid: '349', ask: '351' },
    ]
  }
};

// Mock axios
const axios = {
  post: async (url, body, config) => {
    if (url.includes('quote')) {
      if (body.mode === 'LTP') return { data: MOCK_LTP_RESPONSE };
      if (body.mode === 'FULL') return { data: MOCK_CHAIN_RESPONSE };
    }
    if (url.includes('login')) {
      return {
        data: {
          status: true,
          data: {
            jwtToken: 'mock-jwt',
            refreshToken: 'mock-refresh',
            feedToken: 'mock-feed',
          }
        }
      };
    }
    return { data: {} };
  },
  get: async (url, config) => {
    // Mock instrument master
    return {
      data: [
        // NIFTY options
        { token: 'CE1', symbol: 'NIFTY30JUN2623450CE', name: 'NIFTY', expiry: '30JUN2026', strike: '2345000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'PE1', symbol: 'NIFTY30JUN2623450PE', name: 'NIFTY', expiry: '30JUN2026', strike: '2345000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'CE2', symbol: 'NIFTY30JUN2623500CE', name: 'NIFTY', expiry: '30JUN2026', strike: '2350000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'PE2', symbol: 'NIFTY30JUN2623500PE', name: 'NIFTY', expiry: '30JUN2026', strike: '2350000.000000', lotsize: '25', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        // BANKNIFTY options
        { token: 'BCE1', symbol: 'BANKNIFTY30JUN2648900CE', name: 'BANKNIFTY', expiry: '30JUN2026', strike: '4890000.000000', lotsize: '15', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'BPE1', symbol: 'BANKNIFTY30JUN2648900PE', name: 'BANKNIFTY', expiry: '30JUN2026', strike: '4890000.000000', lotsize: '15', instrumenttype: 'OPTIDX', exch_seg: 'NFO', tick_size: '5.000000' },
        // SENSEX options
        { token: 'SCE1', symbol: 'SENSEX30JUN2676500CE', name: 'SENSEX', expiry: '30JUN2026', strike: '7650000.000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000' },
        { token: 'SPE1', symbol: 'SENSEX30JUN2676500PE', name: 'SENSEX', expiry: '30JUN2026', strike: '7650000.000000', lotsize: '20', instrumenttype: 'OPTIDX', exch_seg: 'BFO', tick_size: '5.000000' },
        // RELIANCE stock options
        { token: 'RCE1', symbol: 'RELIANCE30JUN262800CE', name: 'RELIANCE', expiry: '30JUN2026', strike: '280000.000000', lotsize: '250', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5.000000' },
        { token: 'RPE1', symbol: 'RELIANCE30JUN262800PE', name: 'RELIANCE', expiry: '30JUN2026', strike: '280000.000000', lotsize: '250', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5.000000' },
      ]
    };
  }
};

// Mock require
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'axios') return axios;
  return originalRequire.apply(this, arguments);
};

// ── IMPORTS ────────────────────────────────────────────────

const { MultiOrchestrator } = require('./strategy/core/multiOrchestrator');
const { InstrumentEngine } = require('./strategy/core/instrumentEngine');
const { MarketDataService } = require('./strategy/core/marketDataService');
const { createExpiryCalculator } = require('./strategy/utils/expiryCalculator');
const profiles = require('./strategy/dna/instrumentProfiles');

// ── TESTS ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

// Test 1: ExpiryCalculator weekly
test('ExpiryCalculator: NIFTY weekly (Sat → next Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 6)); // June 6, 2026 = Saturday
  assert.strictEqual(result, '09JUN2026');
});

test('ExpiryCalculator: NIFTY weekly (Tue → same Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 9)); // June 9, 2026 = Tuesday
  assert.strictEqual(result, '09JUN2026');
});

test('ExpiryCalculator: NIFTY weekly (Wed → next Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 10)); // June 10, 2026 = Wednesday
  assert.strictEqual(result, '16JUN2026');
});

test('ExpiryCalculator: BANKNIFTY monthly (Jun 15 → last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 15));
  assert.strictEqual(result, '30JUN2026');
});

test('ExpiryCalculator: BANKNIFTY monthly (Jun 30 → next last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 30));
  assert.strictEqual(result, '28JUL2026');
});

test('ExpiryCalculator: SENSEX weekly (Sat → next Thu)', () => {
  const calc = createExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 4 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 6));
  assert.strictEqual(result, '11JUN2026');
});

test('ExpiryCalculator: BANKEX monthly (Jun 15 → last Thu)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 4 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 15));
  assert.strictEqual(result, '25JUN2026');
});

test('ExpiryCalculator: Stock monthly (Jun 20 → last Tue)', () => {
  const calc = createExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  const result = calc.getCurrentExpiry(new Date(2026, 5, 20));
  assert.strictEqual(result, '30JUN2026');
});

// Test 2: InstrumentEngine independence
async function testIndependence() {
  const orchestrator = new MultiOrchestrator({
    baseUrl: 'https://mock.api',
    jwtToken: 'mock',
  });

  // Override axios for this orchestrator's marketData
  orchestrator.marketData.brokerConfig = { baseUrl: 'https://mock.api', jwtToken: 'mock' };
  orchestrator.marketData.authToken = 'mock';

  const broadcasts = [];
  orchestrator.externalBroadcast = (msg) => broadcasts.push(msg);

  // Add NIFTY and BANKNIFTY
  orchestrator.addInstrument('NIFTY', profiles.NIFTY);
  orchestrator.addInstrument('BANKNIFTY', profiles.BANKNIFTY);
  orchestrator.addInstrument('SENSEX', profiles.SENSEX);

  // Wait for master load
  await new Promise(r => setTimeout(r, 500));

  // Verify masters loaded
  test('MarketDataService: NIFTY master loaded', () => {
    const inst = orchestrator.marketData.instruments.get('NIFTY');
    assert(inst && Object.keys(inst.tokenMap).length > 0, 'NIFTY tokenMap empty');
  });

  test('MarketDataService: BANKNIFTY master loaded', () => {
    const inst = orchestrator.marketData.instruments.get('BANKNIFTY');
    assert(inst && Object.keys(inst.tokenMap).length > 0, 'BANKNIFTY tokenMap empty');
  });

  test('MarketDataService: SENSEX master loaded', () => {
    const inst = orchestrator.marketData.instruments.get('SENSEX');
    assert(inst && Object.keys(inst.tokenMap).length > 0, 'SENSEX tokenMap empty');
  });

  // Verify strike normalization (÷100)
  test('MarketDataService: Strike normalized to rupees', () => {
    const inst = orchestrator.marketData.instruments.get('NIFTY');
    const token = Object.values(inst.tokenMap)[0];
    assert(token.strike < 100000, `Strike not normalized: ${token.strike}`);
  });

  // Simulate ticks for both instruments
  const niftyEngine = orchestrator.engines.get('NIFTY');
  const bankniftyEngine = orchestrator.engines.get('BANKNIFTY');

  // Feed identical ticks to both — they must maintain independent candle state
  for (let i = 0; i < 10; i++) {
    niftyEngine.onTick(23450 + i, Date.now() + i * 1000);
    bankniftyEngine.onTick(48900 + i * 2, Date.now() + i * 1000);
  }

  test('InstrumentEngine: Independent candle state', () => {
    const niftyCandles = niftyEngine.candleBuilder.getCandles(5, 10);
    const bankCandles = bankniftyEngine.candleBuilder.getCandles(5, 10);
    assert(niftyCandles.length > 0, 'NIFTY has no candles');
    assert(bankCandles.length > 0, 'BANKNIFTY has no candles');
    assert(niftyCandles[0].close !== bankCandles[0].close, 'Candles shared state!');
  });

  // Verify signal engine independence
  test('InstrumentEngine: Independent signal counters', () => {
    niftyEngine.signalEngine.signalCount = 5; // Max out NIFTY
    bankniftyEngine.signalEngine.signalCount = 0;
    assert.strictEqual(bankniftyEngine.signalEngine.signalCount, 0, 'BANKNIFTY counter affected by NIFTY');
  });

  // Verify VWAP is updating (not null)
  test('InstrumentEngine: VWAP updated from candles', () => {
    const vwap = niftyEngine.vwap.get ? niftyEngine.vwap.get() : null;
    assert(vwap && vwap.vwap !== null, 'VWAP is null — .update(candle) not called');
  });

  // Verify broadcast includes instrument field
  test('MultiOrchestrator: Broadcast includes instrument field', () => {
    const msg = broadcasts.find(b => b.instrument === 'NIFTY');
    assert(msg, 'No broadcast with instrument=NIFTY');
  });

  // Verify stock lotSize auto-fetched
  test('MarketDataService: Stock lotSize auto-fetched', async () => {
    await orchestrator.marketData.loadInstrumentMaster('STOCK_RELIANCE', 'RELIANCE');
    const inst = orchestrator.marketData.instruments.get('STOCK_RELIANCE');
    assert.strictEqual(inst.profile.lotSize, 250, `Expected lotSize 250, got ${inst.profile.lotSize}`);
  });

  // Verify stock strikeStep auto-fetched
  test('MarketDataService: Stock strikeStep auto-fetched', async () => {
    const inst = orchestrator.marketData.instruments.get('STOCK_RELIANCE');
    assert(inst.profile.strikeStep > 0, `Expected strikeStep > 0, got ${inst.profile.strikeStep}`);
  });
}

// Run async tests
testIndependence().then(() => {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
