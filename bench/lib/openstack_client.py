"""
bench.lib.openstack_client — Helper utilities for OpenStack CLI/SDK interactions.
Enforces the CSTAM safety rule: only ever query/clean resources with prefix 'bench-'.
"""

import json
import subprocess
from typing import Any, Dict, List, Optional

RESOURCE_PREFIX = "bench-"
PROTECTED_NAMES = {"team1", "team2", "felcloud-bastion", "felcloud-gw1", "felcloud-gw2"}


def is_benchmark_resource(name: str, prefix: str = RESOURCE_PREFIX, protected_names=None) -> bool:
    protected = PROTECTED_NAMES if protected_names is None else set(protected_names)
    return bool(name) and name.startswith(prefix) and name not in protected

class OpenStackClient:
    def __init__(self, cloud: str = "felcloud"):
        self.cloud = cloud

    def _run_cmd(self, args: List[str]) -> subprocess.CompletedProcess:
        cmd = ["openstack", "--os-cloud", self.cloud] + args
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)

    def get_quotas(self) -> Dict[str, Any]:
        """Fetch compute and network quotas to identify environment limits."""
        quotas: Dict[str, Any] = {}
        # Compute quota
        res_comp = self._run_cmd(["quota", "show", "--compute", "-f", "json"])
        if res_comp.returncode == 0:
            try:
                for row in json.loads(res_comp.stdout):
                    prop = row.get("Property", row.get("Resource", ""))
                    val = row.get("Value", row.get("Limit", None))
                    quotas[f"compute_{prop}"] = val
            except Exception:
                pass

        # Network quota
        res_net = self._run_cmd(["quota", "show", "--network", "-f", "json"])
        if res_net.returncode == 0:
            try:
                for row in json.loads(res_net.stdout):
                    prop = row.get("Property", row.get("Resource", ""))
                    val = row.get("Value", row.get("Limit", None))
                    quotas[f"network_{prop}"] = val
            except Exception:
                pass

        return quotas

    def list_benchmark_servers(self) -> List[Dict[str, Any]]:
        """List ONLY servers whose name starts with 'bench-'."""
        res = self._run_cmd(["server", "list", "-f", "json"])
        if res.returncode != 0:
            return []
        try:
            servers = json.loads(res.stdout)
            return [s for s in servers if is_benchmark_resource(str(s.get("Name", "")))]
        except Exception:
            return []

    def list_benchmark_ports(self) -> List[Dict[str, Any]]:
        """List ONLY ports whose name starts with 'bench-'."""
        res = self._run_cmd(["port", "list", "-f", "json"])
        if res.returncode != 0:
            return []
        try:
            ports = json.loads(res.stdout)
            return [p for p in ports if is_benchmark_resource(str(p.get("Name", "")))]
        except Exception:
            return []

    def get_server_status(self, server_id: str) -> Optional[str]:
        res = self._run_cmd(["server", "show", server_id, "-f", "json", "-c", "status"])
        if res.returncode != 0:
            return None
        try:
            data = json.loads(res.stdout)
            return data.get("status")
        except Exception:
            return None

    def delete_server_safe(self, server_id: str, server_name: str) -> bool:
        """Safely delete server only if name starts with 'bench-'."""
        if not is_benchmark_resource(server_name):
            raise ValueError(f"CRITICAL SAFETY VIOLATION: Attempted to delete non-benchmark server: {server_name}")
        res = self._run_cmd(["server", "delete", server_id])
        return res.returncode == 0

    def delete_port_safe(self, port_id: str, port_name: str) -> bool:
        """Safely delete port only if name starts with 'bench-'."""
        if not is_benchmark_resource(port_name):
            raise ValueError(f"CRITICAL SAFETY VIOLATION: Attempted to delete non-benchmark port: {port_name}")
        res = self._run_cmd(["port", "delete", port_id])
        return res.returncode == 0
