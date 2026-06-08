// ============================================================
// SOA TRADER SERVER — Multi-Instrument Architecture
// Node.js 20, Express 4, WebSocket (ws)
// ============================================================

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const otplib = require('otplib');

const config = require('./config');
const logger = require('./logger');
const db = require('./database');
const health = require('./health');

// Multi-instrument imports — wrapped for visibility
let multiOrchestrator, profiles, StockScanner;
try {
  multiOrchestrator = require('./strategy/core/multiOrchestrator');
  profiles = require('./strategy/dna/instrumentProfiles');
  const stockScannerModule = require('./strategy/stockScanner');
  StockScanner = stockScannerModule.StockScanner;
  logger.info('✅ All strategy modules loaded successfully');
} catch (err) {
  logger.error(`❌ FATAL: Failed to load strategy modules: ${err.message}`);
  logger.error(err.stack);
  setTimeout(() => process.exit(1), 5000);
  throw err;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let authToken = null;
let refreshToken = null;
let feedToken = null;
let jwtToken = null;
let userProfile = null;
let scanner = null;

// ── UNHANDLED ERRORS ───────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// ── AUTHENTICATION ─────────────────────────────────────────
async function authenticate() {
  logger.info('Starting Angel One authentication...');
  try {
    const totp = otplib.authenticator.generate(config.angel.totpSecret);
    logger.info(`TOTP generated: ${totp}`);

    const loginUrl = `${config.angel.baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`;
    logger.info(`Login URL: ${loginUrl}`);
    logger.info(`Client code: ${config.angel.clientId}`);
    logger.info(`API Key present: ${!!config.angel.apiKey}`);

    const resp = await axios.post(loginUrl, {
      clientcode: config.angel.clientId,
      password: config.angel.password,
      totp: totp,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': 'CLIENT_LOCAL_IP',
        'X-ClientPublicIP': 'CLIENT_PUBLIC_IP',
        'X-MACAddress': 'MAC_ADDRESS',
        'X-PrivateKey': config.angel.apiKey,  // ← REQUIRED: API Key header
      },
      timeout: 30000,
    });

    logger.info(`Login response: ${JSON.stringify(resp.data)}`);

    // Angel One returns { success: true/false, message: "...", data: {...} }
    // OR { status: true/false, message: "...", data: {...} }
    const isSuccess = resp.data?.success === true || resp.data?.status === true;

    if (isSuccess && resp.data?.data) {
      authToken = resp.data.data.jwtToken;
      refreshToken = resp.data.data.refreshToken;
      feedToken = resp.data.data.feedToken;
      jwtToken = authToken;
      userProfile = resp.data.data;

		multiOrchestrator.setAuthToken(authToken);
			if (multiOrchestrator.marketData) {
			multiOrchestrator.marketData.brokerConfig.jwtToken = jwtToken;
			multiOrchestrator.marketData.brokerConfig.baseUrl = config.angel.baseUrl;
			multiOrchestrator.marketData.brokerConfig.apiKey = config.angel.apiKey;
			}


      logger.info('✅ Angel One authenticated successfully');
      broadcastToAllClients({ type: 'AUTH_STATUS', status: 'connected', message: 'Angel One Live' });
      initializeInstruments();
    } else {
      const msg = resp.data?.message || resp.data?.errorCode || 'Authentication failed';
      logger.error(`❌ Login rejected: ${msg}`);
      throw new Error(msg);
    }
  } catch (err) {
    if (err.response) {
      logger.error(`❌ Authentication HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    } else {
      logger.error(`❌ Authentication error: ${err.message}`);
    }
    broadcastToAllClients({ type: 'AUTH_STATUS', status: 'error', message: err.message });
    setTimeout(authenticate, 60000);
  }
}

function initializeInstruments() {
  logger.info(`Initializing instruments: ${config.activeInstruments.join(', ')}`);

  for (const instId of config.activeInstruments) {
    const profile = profiles[instId];
    if (profile) {
      try {
        multiOrchestrator.addInstrument(instId, profile);
        logger.info(`✅ Added instrument: ${instId}`);
      } catch (err) {
        logger.error(`❌ Failed to add instrument ${instId}: ${err.message}`);
      }
    } else {
      logger.warn(`⚠️ No profile found for instrument: ${instId}`);
    }
  }

  if (config.enableStockOptions) {
    try {
      scanner = new StockScanner(multiOrchestrator.marketData, multiOrchestrator);
      scanner.start();
      logger.info('Stock scanner started');
    } catch (err) {
      logger.error(`Failed to start stock scanner: ${err.message}`);
    }
  }
}

// ── WEBSOCKET BROADCAST ────────────────────────────────────
function broadcastToAllClients(msg) {
  const data = JSON.stringify(msg);
  let sent = 0;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); sent++; } catch (_) {}
    }
  });
  return sent;
}

multiOrchestrator.externalBroadcast = (msg) => {
  broadcastToAllClients(msg);
};

// ── WEBSOCKET CONNECTION HANDLER ───────────────────────────
wss.on('connection', (ws) => {
  logger.info('Client connected');

  try {
    ws.send(JSON.stringify({
      type: 'INIT_STATE',
      data: {
        authStatus: authToken ? 'connected' : 'disconnected',
        instruments: multiOrchestrator.getAllSnapshots(),
        config: { trading: config.trading, market: config.market },
      },
    }));
  } catch (err) {
    logger.error(`WS init send error: ${err.message}`);
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'GET_INIT_STATE') {
        try {
          ws.send(JSON.stringify({
            type: 'INIT_STATE',
            data: {
              authStatus: authToken ? 'connected' : 'disconnected',
              instruments: multiOrchestrator.getAllSnapshots(),
              config: { trading: config.trading, market: config.market },
            },
          }));
        } catch (err) {
          logger.error(`WS GET_INIT_STATE send error: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn('WS message parse error');
    }
  });

  ws.on('close', () => {
    logger.info('Client disconnected');
  });

  ws.on('error', (err) => {
    logger.error(`WS client error: ${err.message}`);
  });
});

// ── REST API ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    res.json(health.getStatus());
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: !!authToken,
    instruments: multiOrchestrator.getAllSnapshots(),
    authStatus: authToken ? 'connected' : 'disconnected',
    timestamp: Date.now(),
  });
});

app.get('/api/instruments/:id/snapshot', (req, res) => {
  const snapshot = multiOrchestrator.getSnapshot(req.params.id);
  if (!snapshot) {
    return res.status(404).json({ error: 'Instrument not found' });
  }
  res.json(snapshot);
});

app.get('/api/sensex', (req, res) => {
  const snapshot = multiOrchestrator.getSnapshot('SENSEX');
  if (!snapshot) {
    return res.status(404).json({ error: 'SENSEX not active' });
  }
  res.json({
    ...snapshot,
    lastSensex: snapshot.price,
    liveData: { sensex: snapshot.price, atmStrike: snapshot.atmStrike },
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    trading: config.trading,
    market: config.market,
    activeInstruments: config.activeInstruments,
    enableStockOptions: config.enableStockOptions,
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const resp = await axios.post(`${config.angel.baseUrl}/rest/auth/angelbroking/user/v1/generateToken`, {
      refreshToken: refreshToken,
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'X-PrivateKey': config.angel.apiKey,
      },
    });

    const isSuccess = resp.data?.success === true || resp.data?.status === true;
    if (isSuccess && resp.data?.data) {
      authToken = resp.data.data.jwtToken;
      refreshToken = resp.data.data.refreshToken;
      feedToken = resp.data.data.feedToken;
      multiOrchestrator.setAuthToken(authToken);
      res.json({ status: 'success', message: 'Token refreshed' });
    } else {
      throw new Error(resp.data?.message || 'Refresh failed');
    }
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── START SERVER ───────────────────────────────────────────
const PORT = config.server.port;
const HOST = config.server.host;

server.listen(PORT, HOST, () => {
  logger.info(`🚀 SOA Trader server running on http://${HOST}:${PORT}`);
  logger.info(`📊 Active instruments: ${config.activeInstruments.join(', ')}`);
  logger.info(`📈 Stock options enabled: ${config.enableStockOptions}`);

  setTimeout(() => {
    authenticate();
  }, 1000);
});

server.on('error', (err) => {
  logger.error(`Server error: ${err.message}`);
  process.exit(1);
});

function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    try {
      if (db && typeof db.close === 'function') {
        db.close();
        logger.info('Database closed');
      }
    } catch (err) {
      logger.error(`DB close error: ${err.message}`);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
