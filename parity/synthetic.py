"""Deterministic synthetic Binance 15m klines. Mirrors tests/parity/synthetic.ts bit-for-bit."""

M = 0xFFFFFFFF
START_MS = 1735689600000  # 2025-01-01T00:00:00Z
MIN15 = 900_000


class XorShift32:
    def __init__(self, seed: int) -> None:
        self.x = (seed & M) or 1

    def next(self) -> float:
        x = self.x
        x ^= (x << 13) & M
        x ^= x >> 17
        x ^= (x << 5) & M
        self.x = x & M
        return self.x / 4294967296.0


def generate(seed: int, bars: int, gap_prob: float, vol: float):
    rng = XorShift32(seed)
    out = []
    price = 100.0
    drift = 0.0
    t = START_MS
    for n in range(bars):
        if n % 97 == 0:
            drift = (rng.next() * 2.0 - 1.0) * vol * 0.3
        r = rng.next() * 2.0 - 1.0
        o = price
        c = o * (1.0 + (r * vol + drift))
        h = max(o, c) * (1.0 + rng.next() * vol * 0.5)
        l = min(o, c) * (1.0 - rng.next() * vol * 0.5)
        v = 100.0 + rng.next() * 900.0
        tb = v * (0.2 + rng.next() * 0.6)
        skip = rng.next() < gap_prob
        if not skip:
            out.append({"openTime": t, "open": o, "high": h, "low": l, "close": c, "volume": v, "takerBuyBase": tb})
        price = c
        t += MIN15
    return out
