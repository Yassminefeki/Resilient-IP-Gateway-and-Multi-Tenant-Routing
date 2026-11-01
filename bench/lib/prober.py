"""Async gateway polling and continuous probing with monotonic raw samples."""
import asyncio
import csv
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx


def utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class PollResult:
    success: bool
    status_code: int
    attempts: int
    started_utc: str
    first_200_utc: Optional[str]
    started_perf_counter: float
    first_200_perf_counter: Optional[float]
    elapsed_seconds: float
    error: str = ""


async def wait_until_http_200(target_url: str, host_header: str, *, timeout: float = 60.0,
                              interval: float = 0.5, request_timeout: float = 3.0) -> PollResult:
    """Poll a gateway/VIP URL, preserving Host routing, until HTTP 200 or timeout."""
    start = time.perf_counter()
    start_utc = utc_iso_now()
    attempts, last_status, last_error = 0, 0, ""
    http = httpx.AsyncClient(timeout=request_timeout, follow_redirects=False)
    try:
        while True:
            attempts += 1
            try:
                response = await http.get(target_url, headers={"Host": host_header,
                                                               "User-Agent": "FelCloud-Benchmark-Prober/1.0"})
                last_status = response.status_code
                if last_status == 200:
                    ended = time.perf_counter()
                    return PollResult(True, last_status, attempts, start_utc, utc_iso_now(), start,
                                       ended, ended - start)
                last_error = f"HTTP {last_status}"
            except (httpx.HTTPError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            elapsed = time.perf_counter() - start
            if elapsed >= timeout:
                return PollResult(False, last_status, attempts, start_utc, None, start, None,
                                  elapsed, last_error or "poll timeout")
            await asyncio.sleep(min(interval, max(0.0, timeout - elapsed)))
    finally:
        await http.aclose()


class BackgroundProber:
    """Periodic asynchronous HTTP prober. `stop()` writes every sample to CSV."""
    def __init__(self, target_url: str, host_header: str, *, interval_seconds: float = 0.1,
                 timeout_seconds: float = 1.0, output_csv=None):
        if interval_seconds <= 0 or timeout_seconds <= 0:
            raise ValueError("probe interval and timeout must be positive")
        self.target_url = target_url
        self.host_header = host_header
        self.interval = interval_seconds
        self.timeout = timeout_seconds
        self.output_csv = Path(output_csv) if output_csv else None
        self.samples: List[Dict[str, Any]] = []
        self._stop = asyncio.Event()
        self._task = None
        self._client = None

    async def start(self):
        if self._task is not None:
            raise RuntimeError("prober already started")
        self.samples.clear()
        self._stop = asyncio.Event()
        self._client = httpx.AsyncClient(timeout=self.timeout, follow_redirects=False)
        self._task = asyncio.create_task(self._run())
        return self

    async def _run(self):
        while not self._stop.is_set():
            tick = time.perf_counter()
            started_utc = utc_iso_now()
            row = {"timestamp_utc": started_utc, "perf_counter_start": tick,
                   "perf_counter_end": None, "target_url": self.target_url,
                   "host_header": self.host_header, "status_code": 0,
                   "latency_ms": None, "success": False, "gateway_id": "", "error": ""}
            try:
                response = await self._client.get(self.target_url, headers={
                    "Host": self.host_header, "User-Agent": "FelCloud-Benchmark-Prober/1.0"})
                row["status_code"] = response.status_code
                row["gateway_id"] = response.headers.get("X-Gateway-ID", "")
                row["success"] = response.status_code == 200
                if not row["success"]:
                    row["error"] = f"HTTP {response.status_code}"
            except (httpx.HTTPError, OSError) as exc:
                row["error"] = f"{type(exc).__name__}: {exc}"
            ended = time.perf_counter()
            row["perf_counter_end"] = ended
            row["latency_ms"] = (ended - tick) * 1000.0
            self.samples.append(row)
            delay = self.interval - (time.perf_counter() - tick)
            if delay > 0:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass

    async def stop(self, output_csv=None):
        if self._task is None:
            return []
        self._stop.set()
        await self._task
        await self._client.aclose()
        self._task = None
        target = Path(output_csv) if output_csv else self.output_csv
        if target:
            self.write_csv(target)
        return list(self.samples)

    def write_csv(self, output_csv):
        path = Path(output_csv)
        path.parent.mkdir(parents=True, exist_ok=True)
        fields = ["timestamp_utc", "perf_counter_start", "perf_counter_end", "target_url",
                  "host_header", "status_code", "latency_ms", "success", "gateway_id", "error"]
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(self.samples)
        return path


# Backward compatible name for callers migrating from the previous prober.
ContinuousProber = BackgroundProber
