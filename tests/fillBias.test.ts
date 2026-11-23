import { describe, expect, it } from "vitest";
import { Engine082f, type Bar15m } from "../src/strategy/engine082f.js";

/**
 * On a driftless random walk no entry rule can have an edge, so mean R must be ~0.
 * The Python limit_1bar fill model (marketable limit filled at the limit price) is
 * biased by about -0.2 R per trade; the realistic model is not.
 */
function walk(seed: number, n: number): Bar15m[] {
  let x = seed >>> 0 || 1;
  const r = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
  const out: Bar15m[] = [];
  let p = 100;
  let t = 1735689600000;
  for (let i = 0; i < n; i++) {
    const o = p;
    let h = p;
    let l = p;
    for (let k = 0; k < 15; k++) {
      p *= 1 + Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) * 0.0015;
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    const v = 100 + r() * 900;
    out.push({ openTime: t, open: o, high: h, low: l, close: p, volume: v, takerBuyBase: v * r() });
    t += 900_000;
  }
  return out;
}

function meanR(opts: Partial<ConstructorParameters<typeof Engine082f>[0]>): number {
  let n = 0;
  let sum = 0;
  for (let s = 1; s <= 12; s++) {
    const e = new Engine082f({ symbol: "T", rrTarget: 2, ...opts });
    walk(s * 7919, 20_000).forEach((b) => e.on15mBar(b));
    e.flush();
    for (const t of e.trades) {
      n += 1;
      sum += t.rr;
    }
  }
  return sum / n;
}

describe("fill model bias on a random walk", () => {
  it("Python limit_1bar fills lose ~0.2R per trade on pure noise", () => {
    expect(meanR({})).toBeLessThan(-0.1);
  });
  it("realistic fills are unbiased", () => {
    expect(Math.abs(meanR({ immediateFillAtMarket: true, checkExitsAfterImmediateFill: true }))).toBeLessThan(0.1);
  });
  it("market mode is unbiased", () => {
    expect(Math.abs(meanR({ entryMode: "market" }))).toBeLessThan(0.1);
  });
});
