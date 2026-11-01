"""
bench.lib.stats — Statistical calculations and raw data export for benchmark metrics.
Uses time.perf_counter for monotonic timing, and datetime.now(timezone.utc) for event timestamps.
"""

import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

def utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def compute_stats(samples: List[Union[int, float]]) -> Dict[str, Any]:
    if not samples:
        return {
            "n": 0,
            "min": None,
            "mean": None,
            "std": None,
            "p50": None,
            "p90": None,
            "p95": None,
            "p99": None,
            "max": None,
        }

    s_sorted = sorted(samples)
    n = len(s_sorted)
    mean_val = sum(s_sorted) / n
    variance = sum((x - mean_val) ** 2 for x in s_sorted) / n if n > 1 else 0.0
    std_val = math.sqrt(variance)

    def percentile(p: float) -> float:
        if n == 1:
            return s_sorted[0]
        k = (n - 1) * (p / 100.0)
        f = math.floor(k)
        c = math.ceil(k)
        if f == c:
            return s_sorted[int(k)]
        d0 = s_sorted[int(f)] * (c - k)
        d1 = s_sorted[int(c)] * (k - f)
        return d0 + d1

    return {
        "n": n,
        "min": round(s_sorted[0], 4),
        "mean": round(mean_val, 4),
        "std": round(std_val, 4),
        "p50": round(percentile(50), 4),
        "p90": round(percentile(90), 4),
        "p95": round(percentile(95), 4),
        "p99": round(percentile(99), 4),
        "max": round(s_sorted[-1], 4),
    }

def save_raw_csv(filepath: Union[str, Path], rows: List[Dict[str, Any]], fieldnames: Optional[List[str]] = None) -> Path:
    path = Path(filepath)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        return path

    keys = fieldnames or list(dict.fromkeys(key for row in rows for key in row.keys()))
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)
    return path

def save_summary_json(filepath: Union[str, Path], data: Dict[str, Any]) -> Path:
    path = Path(filepath)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return path
