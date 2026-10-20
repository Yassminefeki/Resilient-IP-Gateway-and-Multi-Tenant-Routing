"""
bench.lib.api_client — Synchronous and Asynchronous HTTP client for the FelCloud Control Plane API.
"""

import httpx
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Tuple
from urllib.parse import quote


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class TimedResponse:
    status_code: int
    data: Dict[str, Any]
    elapsed_seconds: float
    started_utc: str
    finished_utc: str
    started_perf_counter: float
    finished_perf_counter: float


class AsyncControlPlaneClient:
    """Async httpx client for the configured live control plane."""
    def __init__(self, base_url: str, admin_token: str, timeout: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        headers = {"Content-Type": "application/json", "User-Agent": "FelCloud-Benchmark/1.0"}
        if admin_token:
            headers["Authorization"] = f"Bearer {admin_token}"
        self._client = httpx.AsyncClient(base_url=self.base_url, headers=headers,
                                         timeout=timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        await self.close()

    async def request(self, method: str, path: str, *, json_body=None, params=None) -> TimedResponse:
        started_perf = time.perf_counter()
        started_utc = _utc_iso()
        response = await self._client.request(method, path, json=json_body, params=params)
        finished_perf = time.perf_counter()
        finished_utc = _utc_iso()
        try:
            payload = response.json()
            data = payload if isinstance(payload, dict) else {"data": payload}
        except (ValueError, UnicodeDecodeError):
            data = {"raw": response.text}
        return TimedResponse(response.status_code, data, finished_perf - started_perf,
                             started_utc, finished_utc, started_perf, finished_perf)

    async def health(self) -> TimedResponse:
        return await self.request("GET", "/health")

    async def provision_sandbox(self, team: str, ttl: int = 3600,
                                custom_domain: str = "") -> TimedResponse:
        payload = {"team": team, "ttl": ttl}
        if custom_domain:
            payload["custom_domain"] = custom_domain
        return await self.request("POST", "/api/sandboxes/provision", json_body=payload)

    async def delete_sandbox(self, team: str) -> TimedResponse:
        from bench.lib.openstack_client import is_benchmark_resource
        if not is_benchmark_resource(team):
            raise ValueError("Refusing to delete a sandbox without the bench- prefix")
        return await self.request("DELETE", f"/api/sandboxes/{quote(team, safe='')}")

    async def list_sandboxes(self) -> TimedResponse:
        return await self.request("GET", "/api/sandboxes")

class ControlPlaneClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8081", admin_token: str = "", timeout: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.admin_token = admin_token
        self.timeout = timeout
        self.headers = {
            "Content-Type": "application/json",
            "User-Agent": "FelCloud-Benchmark-Prober/1.0",
        }
        if self.admin_token:
            self.headers["Authorization"] = f"Bearer {self.admin_token}"

    def get_sync_client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, headers=self.headers, timeout=self.timeout)

    def get_async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.base_url, headers=self.headers, timeout=self.timeout)

    # ── Synchronous API Methods ────────────────────────────────────────────────

    def health(self) -> Tuple[int, Dict[str, Any]]:
        with self.get_sync_client() as client:
            resp = client.get("/health")
            try:
                return resp.status_code, resp.json()
            except Exception:
                return resp.status_code, {"raw": resp.text}

    def provision_sandbox(self, team: str, ttl: int = 3600, custom_domain: str = "") -> Tuple[int, Dict[str, Any], float]:
        payload: Dict[str, Any] = {"team": team, "ttl": ttl}
        if custom_domain:
            payload["custom_domain"] = custom_domain
        with self.get_sync_client() as client:
            resp = client.post("/api/sandboxes/provision", json=payload)
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def delete_sandbox(self, team: str) -> Tuple[int, Dict[str, Any], float]:
        with self.get_sync_client() as client:
            resp = client.delete(f"/api/sandboxes/{team}")
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def list_sandboxes(self) -> Tuple[int, Dict[str, Any]]:
        with self.get_sync_client() as client:
            resp = client.get("/api/sandboxes")
            try:
                return resp.status_code, resp.json()
            except Exception:
                return resp.status_code, {"raw": resp.text}

    def list_leases(self) -> Tuple[int, Dict[str, Any]]:
        with self.get_sync_client() as client:
            resp = client.get("/api/leases")
            try:
                return resp.status_code, resp.json()
            except Exception:
                return resp.status_code, {"raw": resp.text}

    def allocate_lease(self, sandbox_id: str, preferred_ip: str = "", ttl: int = 3600) -> Tuple[int, Dict[str, Any], float]:
        payload: Dict[str, Any] = {"sandbox_id": sandbox_id, "ttl": ttl}
        if preferred_ip:
            payload["ip_address"] = preferred_ip
        with self.get_sync_client() as client:
            resp = client.post("/api/leases/allocate", json=payload)
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def release_lease(self, sandbox_id: str, ip_address: str) -> Tuple[int, Dict[str, Any], float]:
        payload = {"sandbox_id": sandbox_id, "ip_address": ip_address}
        with self.get_sync_client() as client:
            resp = client.post("/api/leases/release", json=payload)
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def reclaim_leases(self) -> Tuple[int, Dict[str, Any], float]:
        with self.get_sync_client() as client:
            resp = client.post("/api/leases/reclaim")
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def gateway_status(self, refresh: bool = False) -> Tuple[int, Dict[str, Any]]:
        with self.get_sync_client() as client:
            resp = client.get("/api/gateways/status", params={"refresh": "true"} if refresh else {})
            try:
                return resp.status_code, resp.json()
            except Exception:
                return resp.status_code, {"raw": resp.text}

    def gateway_failover(self, target_gateway: str = "gw2", confirm: bool = True) -> Tuple[int, Dict[str, Any], float]:
        payload = {"target_gateway": target_gateway, "confirm": confirm}
        with self.get_sync_client() as client:
            resp = client.post("/api/gateways/failover", json=payload)
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def gateway_rollback(self, target_generation: str = "") -> Tuple[int, Dict[str, Any], float]:
        payload = {"target_generation": target_generation}
        with self.get_sync_client() as client:
            resp = client.post("/api/gateways/rollback", json=payload)
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed

    def gateway_sync(self, dry_run: bool = False) -> Tuple[int, Dict[str, Any], float]:
        with self.get_sync_client() as client:
            resp = client.post("/api/gateways/sync", params={"dry_run": "true"} if dry_run else {})
            elapsed = resp.elapsed.total_seconds()
            try:
                return resp.status_code, resp.json(), elapsed
            except Exception:
                return resp.status_code, {"raw": resp.text}, elapsed
