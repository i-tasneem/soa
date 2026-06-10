// ============================================================
// BUILD v7 — Broker-Agnostic Instrument Master Download
// Changes from v6:
// 1. Uses broker adapter to download instrument master
// 2. Supports both Angel and Dhan masters
// 3. Creates unified instruments.json with broker-specific fields
// ============================================================

const fs = require('fs');
const path = require('path');
const { createBrokerAdapter } = require('./broker');
const logger = require('./logger');
const config = require('./config');

async function build() {
  try {
    logger.info('[Build] Starting instrument master build...');

    const brokerType = config.broker?.type || 'angel';
    const brokerAdapter = createBrokerAdapter(brokerType, config.broker);

    logger.info(`[Build] Using broker: ${brokerType}`);

    // Download instrument master
    const master = await brokerAdapter.getInstrumentMaster();

    if (!Array.isArray(master) || master.length === 0) {
      throw new Error('Empty instrument master received');
    }

    logger.info(`[Build] Downloaded ${master.length} instruments`);

    // Filter relevant instruments
    const relevant = master.filter(item => {
      const name = item.name || item.symbol || item.tradingsymbol || '';
      const type = item.instrumenttype || item.SEM_INSTRUMENT_NAME || '';
      return (
        (name.includes('NIFTY') || name.includes('BANKNIFTY') || name.includes('SENSEX') || name.includes('BANKEX')) &&
        (type === 'OPTIDX' || type.includes('OPT'))
      );
    });

    logger.info(`[Build] Filtered ${relevant.length} relevant instruments`);

    // Create unified mapping
    const instruments = {
      meta: {
        broker: brokerType,
        generatedAt: new Date().toISOString(),
        totalCount: master.length,
        relevantCount: relevant.length,
      },
      indices: {
        NIFTY: relevant.filter(i => (i.name || i.symbol || '').includes('NIFTY') && !(i.name || i.symbol || '').includes('BANK')),
        BANKNIFTY: relevant.filter(i => (i.name || i.symbol || '').includes('BANKNIFTY')),
        SENSEX: relevant.filter(i => (i.name || i.symbol || '').includes('SENSEX') && !(i.name || i.symbol || '').includes('BANK')),
        BANKEX: relevant.filter(i => (i.name || i.symbol || '').includes('BANKEX')),
      },
      all: relevant,
    };

    // Write to file
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(dataDir, 'instruments.json'),
      JSON.stringify(instruments, null, 2)
    );

    fs.writeFileSync(
      path.join(dataDir, 'instruments.meta.json'),
      JSON.stringify(instruments.meta, null, 2)
    );

    logger.info('[Build] Instrument master build complete');
    return instruments;
  } catch (err) {
    logger.error(`[Build] Failed: ${err.message}`);
    throw err;
  }
}

// Run if called directly
if (require.main === module) {
  build().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { build };
