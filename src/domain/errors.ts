export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class ConfigError extends DomainError {
  constructor(message: string) {
    super("CONFIG", message);
    this.name = "ConfigError";
  }
}

export class MarketDataError extends DomainError {
  constructor(message: string) {
    super("MARKET_DATA", message);
    this.name = "MarketDataError";
  }
}

export class RiskRejectedError extends DomainError {
  constructor(message: string) {
    super("RISK_REJECTED", message);
    this.name = "RiskRejectedError";
  }
}

export class LiveTradingDisabledError extends DomainError {
  constructor() {
    super(
      "LIVE_DISABLED",
      "LIVE execution is disabled. Set TRADING_MODE=PAPER or complete the Before LIVE checklist.",
    );
    this.name = "LiveTradingDisabledError";
  }
}
