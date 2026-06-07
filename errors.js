// ============================================================
//  CUSTOM ERROR CLASSES
//  Structured error handling for trading app
// ============================================================

class TradingError extends Error {
  constructor(code, message, statusCode = 500, meta = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.meta = meta;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      meta: this.meta,
    };
  }
}

// Auth / Authorization
class AuthError extends TradingError {
  constructor(message, meta = {}) {
    super('AUTH_ERROR', message, 401, meta);
  }
}

class InvalidCredentialsError extends TradingError {
  constructor(message = 'Invalid credentials', meta = {}) {
    super('INVALID_CREDENTIALS', message, 401, meta);
  }
}

class TokenExpiredError extends TradingError {
  constructor(message = 'Token has expired', meta = {}) {
    super('TOKEN_EXPIRED', message, 401, meta);
  }
}

class TOTPError extends TradingError {
  constructor(message = 'TOTP verification failed', meta = {}) {
    super('TOTP_ERROR', message, 400, meta);
  }
}

// API / Network
class ApiError extends TradingError {
  constructor(message, statusCode = 500, meta = {}) {
    super('API_ERROR', message, statusCode, meta);
  }
}

class AngelOneApiError extends TradingError {
  constructor(message, statusCode = 500, meta = {}) {
    super('ANGEL_ONE_API_ERROR', message, statusCode, meta);
  }
}

class NetworkError extends TradingError {
  constructor(message = 'Network request failed', meta = {}) {
    super('NETWORK_ERROR', message, 503, meta);
  }
}

class TimeoutError extends TradingError {
  constructor(message = 'Request timeout', meta = {}) {
    super('TIMEOUT_ERROR', message, 504, meta);
  }
}

// Validation / Config
class ValidationError extends TradingError {
  constructor(message, field = null, meta = {}) {
    super('VALIDATION_ERROR', message, 400, { field, ...meta });
  }
}

class ConfigError extends TradingError {
  constructor(message, missingField = null, meta = {}) {
    super('CONFIG_ERROR', message, 500, { missingField, ...meta });
  }
}

// DB
class DatabaseError extends TradingError {
  constructor(message, operation = null, meta = {}) {
    super('DATABASE_ERROR', message, 500, { operation, ...meta });
  }
}

// Trading / Market
class TradingOperationError extends TradingError {
  constructor(message, operation = null, meta = {}) {
    super('TRADING_ERROR', message, 400, { operation, ...meta });
  }
}

class InsufficientPremiumError extends TradingError {
  constructor(message = 'Insufficient premium for trade', meta = {}) {
    super('INSUFFICIENT_PREMIUM', message, 400, meta);
  }
}

class MarketClosedError extends TradingError {
  constructor(message = 'Market is closed', meta = {}) {
    super('MARKET_CLOSED', message, 400, meta);
  }
}

// WebSocket
class WebSocketError extends TradingError {
  constructor(message, reason = null, meta = {}) {
    super('WEBSOCKET_ERROR', message, 503, { reason, ...meta });
  }
}

module.exports = {
  TradingError,
  AuthError,
  InvalidCredentialsError,
  TokenExpiredError,
  TOTPError,
  ApiError,
  AngelOneApiError,
  NetworkError,
  TimeoutError,
  ValidationError,
  ConfigError,
  DatabaseError,
  TradingOperationError,
  InsufficientPremiumError,
  MarketClosedError,
  WebSocketError,
};