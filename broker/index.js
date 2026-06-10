// ============================================================
// BROKER FACTORY — Creates broker adapter based on config
// Usage: const { createBrokerAdapter } = require('./broker');
// ============================================================

const { AngelAdapter } = require('./AngelAdapter');
const { DhanAdapter } = require('./DhanAdapter');

const ADAPTERS = {
  angel: AngelAdapter,
  dhan: DhanAdapter,
};

function createBrokerAdapter(type, config = {}) {
  const AdapterClass = ADAPTERS[type?.toLowerCase()];
  if (!AdapterClass) {
    throw new Error(`Unknown broker type: ${type}. Supported: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return new AdapterClass(config);
}

function getSupportedBrokers() {
  return Object.keys(ADAPTERS);
}

module.exports = {
  createBrokerAdapter,
  getSupportedBrokers,
  BrokerAdapter: require('./BrokerAdapter').BrokerAdapter,
  AngelAdapter,
  DhanAdapter,
};
