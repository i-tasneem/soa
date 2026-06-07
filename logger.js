// ============================================================
// LOGGER — Structured Logging Setup
// Replaces console.log with Winston for production-grade logging
// Outputs to:
// - logs/app.log (all logs)
// - logs/error.log (errors only)
// - console (always — Railway/Docker visible)
// ============================================================

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for readable logs
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: { service: 'soa-trader' },
  transports: [
    // Error log — errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Combined log — all levels
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    }),
    // Console — ALWAYS active (Railway, Docker, local dev)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      ),
    }),
  ],
});

// Log levels helper methods
module.exports = {
  // Standard logging
  info: (message, meta) => logger.info(message, meta),
  warn: (message, meta) => logger.warn(message, meta),
  error: (message, meta) => logger.error(message, meta),
  debug: (message, meta) => logger.debug(message, meta),

  // Trading-specific logging
  logTrade: (action, tradeData) => {
    logger.info(`TRADE: ${action}`, {
      type: 'TRADE',
      ...tradeData,
    });
  },

  logSignal: (signalData) => {
    logger.info(`SIGNAL: ${signalData.type} @ ${signalData.confidence}% confidence`, {
      type: 'SIGNAL',
      ...signalData,
    });
  },

  logApiCall: (method, endpoint, statusCode, responseTime) => {
    logger.info(`API_CALL: ${method} ${endpoint} → ${statusCode}`, {
      type: 'API',
      method,
      endpoint,
      statusCode,
      responseTimeMs: responseTime,
    });
  },

  logAuth: (action, status, message) => {
    logger.info(`AUTH: ${action} → ${status}`, {
      type: 'AUTH',
      action,
      status,
      message,
    });
  },

  logWebSocket: (event, status) => {
    logger.info(`WEBSOCKET: ${event} → ${status}`, {
      type: 'WEBSOCKET',
      event,
      status,
    });
  },

  // Raw logger instance (for advanced use)
  logger,
};
