"""Unit checks for T2 response parsing; no network calls are made."""
import unittest

from bench.lib.api_client import TimedResponse
from bench.tests.t2_concurrent_stress import (
    baseline_backend_guard,
    identity_matches,
    ipam_signature,
    is_pool_exhaustion,
    neutron_port_ips,
    parse_api_response,
    provision_sync_failures,
    retry_after_seconds,
    sync_failure_events,
)


class TimedResponseParsingTest(unittest.TestCase):
    def test_parses_harness_timed_response_data(self):
        response = TimedResponse(
            status_code=201,
            data={"sandbox_id": "bench-t2-check", "fixed_ip": "192.0.2.9"},
            elapsed_seconds=0.25,
            started_utc="2026-10-18T00:00:00.000Z",
            finished_utc="2026-10-18T00:00:00.250Z",
            started_perf_counter=1.0,
            finished_perf_counter=1.25,
        )
        self.assertEqual(parse_api_response(response), (201, response.data))

    def test_fixed_ip_match_uses_word_boundaries(self):
        self.assertTrue(identity_matches("FelCloud sandbox ready (10.20.30.4)", "10.20.30.4"))
        self.assertFalse(identity_matches("FelCloud sandbox ready (10.20.30.41)", "10.20.30.4"))
        self.assertFalse(identity_matches("bench-t2-sandbox-id", "10.20.30.4"))

    def test_neutron_names_map_ports_back_to_sandbox_ids(self):
        ports = [
            {"Name": "sandbox-bench-t2-a", "Fixed IP Addresses": "ip_address='10.20.30.37'"},
            {"Name": "sandbox-bench-t2-b", "Fixed IP Addresses": "ip_address='10.20.30.15'"},
            {"Name": "team1", "Fixed IP Addresses": "ip_address='10.20.30.70'"},
        ]
        self.assertEqual(neutron_port_ips(ports, ["bench-t2-a", "bench-t2-b"]),
                         {"bench-t2-a": "10.20.30.37", "bench-t2-b": "10.20.30.15"})

    def test_baseline_guard_accepts_exact_gateway_backends(self):
        baseline = "backend default_maintenance\nbackend team1_backend\nbackend team2_backend\n"
        valid, details = baseline_backend_guard({"gw1": baseline, "gw2": baseline})
        self.assertTrue(valid)
        self.assertEqual(details["expected"], ["default_maintenance", "team1_backend", "team2_backend"])
        self.assertEqual(details["found"]["gw1"], details["expected"])
        self.assertEqual(details["found"]["gw2"], details["expected"])

    def test_baseline_guard_reports_unexpected_backend(self):
        baseline = "backend default_maintenance\nbackend team1_backend\nbackend team2_backend\n"
        extra = baseline + "backend bench-leftover_backend\n"
        valid, details = baseline_backend_guard({"gw1": extra, "gw2": baseline})
        self.assertFalse(valid)
        self.assertEqual(details["difference"]["gw1"]["unexpected"], ["bench-leftover_backend"])
        self.assertEqual(details["difference"]["gw1"]["missing"], [])

    def test_baseline_guard_reports_missing_backend(self):
        baseline = "backend default_maintenance\nbackend team1_backend\nbackend team2_backend\n"
        missing = "backend default_maintenance\nbackend team2_backend\n"
        valid, details = baseline_backend_guard({"gw1": missing, "gw2": baseline})
        self.assertFalse(valid)
        self.assertEqual(details["difference"]["gw1"]["missing"], ["team1_backend"])
        self.assertEqual(details["difference"]["gw1"]["unexpected"], [])

    def test_sync_event_and_provision_failures_preserve_error_text(self):
        events = [
            {"type": "SYNC", "detail": "trigger=gateway_sync error=busy"},
            {"type": "FAILED", "sandbox_id": "bench-a", "detail": "step=gateway_sync error=backend DOWN"},
            {"type": "SYNC", "detail": "trigger=provision_gateway_sync reason=deploy"},
            {"type": "FAILED", "detail": "step=health error=timeout"},
        ]
        failures = sync_failure_events(events)
        self.assertEqual([failure["error_text"] for failure in failures],
                         ["trigger=gateway_sync error=busy", "step=gateway_sync error=backend DOWN"])
        provisioned = provision_sync_failures([{
            "sandbox_id": "bench-a", "status": "PROVISION_FAILED",
            "provision_response": {"step": "gateway_sync", "error": "409 busy"}, "errors": ["409 busy"]}])
        self.assertEqual(provisioned[0]["error_text"], "409 busy")

    def test_pool_exhaustion_rejects_429_and_retries_using_header_delay(self):
        self.assertFalse(is_pool_exhaustion(429, {"error": "rate limited"}))
        self.assertTrue(is_pool_exhaustion(409, {"error": "No free IPs available in subnet"}))
        self.assertFalse(is_pool_exhaustion(409, {"error": "another conflict"}))
        self.assertEqual(retry_after_seconds({"Retry-After": "3"}), 3.0)

    def test_ipam_signature_normalizes_created_free_rows(self):
        before, _ = ipam_signature([], "10.20.30.0/24")
        after, _ = ipam_signature([{"ip_address": "10.20.30.2", "status": "FREE",
                                   "entity_name": "bench-t2-pool-001"}], "10.20.30.0/24")
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
