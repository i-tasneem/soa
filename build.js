// ============================================================
//  BUILD SCRIPT — Downloads Angel One instrument master file
//  Runs at Railway build time so instruments are available
//  at runtime without needing to fetch the 50MB file live.
//  Usage: node build.js  (called automatically via npm run build)
// ============================================================

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const INSTRUMENT_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEST_PATH      = path.join(DATA_DIR, 'instruments.json');
const META_PATH      = path.join(DATA_DIR, 'instruments.meta.json');

async function downloadInstruments() {
  console.log('🏗️  SOA Trader — Build Script');
  console.log('─'.repeat(50));

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Created data/ directory');
  }

  // Check if we already have a fresh file (within 12h) — skip re-download
  if (fs.existsSync(META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    const ageHours = (Date.now() - meta.downloadedAt) / 3600000;
    if (ageHours < 12 && fs.existsSync(DEST_PATH)) {
      const existing = JSON.parse(fs.readFileSync(DEST_PATH, 'utf8'));
      console.log(`✅ Instruments already fresh (${ageHours.toFixed(1)}h old, ${existing.length} instruments) — skipping download`);
      return;
    }
  }

  console.log('📥 Downloading SENSEX instrument master from Angel One...');
  console.log('   URL:', INSTRUMENT_URL);

  try {
    const res = await axios.get(INSTRUMENT_URL, {
      timeout: 90000, // 90s — file is large
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json',
      },
      responseType: 'json',
    });

    if (!Array.isArray(res.data)) {
      throw new Error(`Unexpected response type: ${typeof res.data}`);
    }

    console.log(`📊 Total instruments received: ${res.data.length}`);

    // Filter to only SENSEX options (BFO exchange) — reduces file size dramatically
    const sensex = res.data.filter(i =>
      i.exch_seg === 'BFO' &&
      i.name === 'SENSEX' &&
      i.instrumenttype === 'OPTIDX'
    );

    if (sensex.length === 0) {
      throw new Error('No SENSEX instruments found in response — data may be malformed');
    }

    // Show sample for verification
    const expiries = [...new Set(sensex.map(i => i.expiry))].sort();
    console.log(`✅ Filtered to ${sensex.length} SENSEX options`);
    console.log(`📅 Expiries available: ${expiries.slice(0, 8).join(', ')}${expiries.length > 8 ? '...' : ''}`);
    if (sensex[0]) {
      console.log(`🔎 Sample: ${JSON.stringify({ token: sensex[0].token, symbol: sensex[0].symbol, expiry: sensex[0].expiry, strike: sensex[0].strike })}`);
    }

    // Write filtered instruments
    fs.writeFileSync(DEST_PATH, JSON.stringify(sensex));
    console.log(`💾 Saved to data/instruments.json (${(Buffer.byteLength(JSON.stringify(sensex)) / 1024).toFixed(1)} KB)`);

    // Write metadata for freshness check
    fs.writeFileSync(META_PATH, JSON.stringify({
      downloadedAt: Date.now(),
      count:        sensex.length,
      expiries:     expiries,
      source:       INSTRUMENT_URL,
    }));

    console.log('✅ Build complete — instruments ready for runtime');

  } catch (err) {
    const status  = err.response?.status;
    const message = err.message;

    console.error('❌ Failed to download instruments');
    console.error('   Error:', message);
    if (status) console.error('   HTTP Status:', status);

    // If we have a stale file, warn but don't fail the build
    if (fs.existsSync(DEST_PATH)) {
      const meta = fs.existsSync(META_PATH)
        ? JSON.parse(fs.readFileSync(META_PATH, 'utf8'))
        : null;
      const ageHours = meta ? ((Date.now() - meta.downloadedAt) / 3600000).toFixed(1) : 'unknown';
      console.warn(`⚠️  Using stale instruments file (${ageHours}h old) — option chain may be outdated`);
      process.exit(0); // Don't fail deploy if we have something to work with
    }

    // No file at all — fail the build
    console.error('💥 No fallback instruments file available — deployment will fail to load option chain');
    console.error('   Fix: Ensure the Railway build environment can reach margincalculator.angelbroking.com');
    process.exit(1);
  }
}

downloadInstruments();
