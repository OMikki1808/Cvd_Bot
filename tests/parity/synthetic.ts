/** Deterministic synthetic Binance 15m klines. Mirrors parity/synthetic.py bit-for-bit. */
import type { Bar15m } from "../../src/strategy/engine082f.js";

export const START_MS = 1735689600000; // 2025-01-01T00:00:00Z
const MIN15 = 900_000;

class XorShift32 {
  private x: number;
  constructor(seed: number) {
    this.x = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.x;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.x = x;
    return x / 4294967296;
  }
}

export function generate(seed: number, bars: number, gapProb: number, vol: number): Bar15m[] {
  const rng = new XorShift32(seed);
  const out: Bar15m[] = [];
  let price = 100;
  let drift = 0;
  let t = START_MS;
  for (let n = 0; n < bars; n++) {
    if (n % 97 === 0) {
      drift = (rng.next() * 2 - 1) * vol * 0.3;
    }
    const r = rng.next() * 2 - 1;
    const o = price;
    const c = o * (1 + (r * vol + drift));
    const h = Math.max(o, c) * (1 + rng.next() * vol * 0.5);
    const l = Math.min(o, c) * (1 - rng.next() * vol * 0.5);
    const v = 100 + rng.next() * 900;
    const tb = v * (0.2 + rng.next() * 0.6);
    const skip = rng.next() < gapProb;
    if (!skip) {
      out.push({ openTime: t, open: o, high: h, low: l, close: c, volume: v, takerBuyBase: tb });
    }
    price = c;
    t += MIN15;
  }
  return out;
}
