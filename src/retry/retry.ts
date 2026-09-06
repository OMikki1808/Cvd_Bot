export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  isRetryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < options.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === options.attempts - 1 || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** i);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Simple token-bucket limiter for REST. Binance futures default weight is generous
 * for kline/aggTrade warmup; this keeps reconnect storms from bursting.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(cost = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = ((cost - this.tokens) / this.refillPerSec) * 1000;
      await sleep(Math.max(20, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
}
