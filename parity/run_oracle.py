"""Run the Python oracle (CVDBot-prodaction limit_1bar engine) on synthetic scenarios.

Usage:
  PRODACTION_PATH=/path/to/CVDBot-prodaction python3 parity/run_oracle.py > tests/fixtures/parity082f.json
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.environ.get("PRODACTION_PATH", "../CVDBot-prodaction"))
sys.path.insert(0, str(Path(__file__).parent))

from cvdbot.strategy.v082f_engine_v2_limit_1bar.engine import (  # noqa: E402
    RuntimeStrategy082FEngineV2Limit1Bar,
)
from synthetic import generate  # noqa: E402


def ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).astimezone(timezone.utc).timestamp() * 1000)


def run(sc: dict) -> dict:
    eng = RuntimeStrategy082FEngineV2Limit1Bar(symbol="TESTUSDT", rr_target=float(sc["rr"]))
    for b in generate(sc["seed"], sc["bars"], sc["gapProb"], sc["vol"]):
        eng.on_15m_bar(
            time=datetime.fromtimestamp(b["openTime"] / 1000.0, tz=timezone.utc),
            open_=b["open"], high=b["high"], low=b["low"], close=b["close"],
            volume=b["volume"], taker_buy_base=b["takerBuyBase"],
        )
    eng.flush_stream()
    trades = [
        {
            "side": t["side"],
            "divergenceTime": ms(t["divergence_time"]),
            "confirmationTime": ms(t["confirmation_time"]),
            "entryTime": ms(t["entry_time"]),
            "exitTime": ms(t["exit_time"]),
            "entry": t["entry"],
            "stop": t["stop"],
            "takeProfit": t["take_profit"],
            "exitPrice": t["exit_price"],
            "qty": t["qty"],
            "pnl": t["pnl"],
            "outcome": t["outcome"],
            "equityAfter": t["equity_after"],
        }
        for t in eng.trades
    ]
    f = eng.funnel
    funnel = {
        "divergenceBullish": f["divergence_bullish"],
        "divergenceBearish": f["divergence_bearish"],
        "confirmLongPass": f["confirm_long_pass"],
        "confirmShortPass": f["confirm_short_pass"],
        "confirmLongFail": f["confirm_long_fail"],
        "confirmShortFail": f["confirm_short_fail"],
        "limitOrdersPlaced": f["limit_orders_placed"],
        "immediateFills": f["immediate_fills"],
        "nextHourFills": f["next_hour_fills"],
        "limitCancelled": f["limit_cancelled"],
        "reverseCloses": f["reverse_closes"],
    }
    return {**sc, "expected": {"finalEquity": eng.equity, "maxDrawdown": eng.max_drawdown, "funnel": funnel, "trades": trades}}


if __name__ == "__main__":
    scenarios = json.loads((Path(__file__).parent / "scenarios.json").read_text())
    print(json.dumps({"oracle": "CVDBot-prodaction cvdbot/strategy/v082f_engine_v2_limit_1bar/engine.py @ fc9145d", "scenarios": [run(s) for s in scenarios]}))
