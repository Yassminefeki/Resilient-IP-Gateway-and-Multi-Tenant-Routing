#!/usr/bin/env python3
"""
Verify that all public documentation, README files, and dashboard data
align with committed benchmark evidence and contain no unsupported claims.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
BENCH_RAW_DIR = ROOT / "bench" / "results" / "raw"
DASHBOARD_BENCHMARKS = ROOT / "dashboard" / "src" / "data" / "committedBenchmarks.ts"

FORBIDDEN_PHRASES = [
    (r"sub-second rollback", "Rollback takes ~9.4-12.6s (includes 5s post-rollback health window)"),
    (r"sub-3-second failover.*t3_failover_20261019T145556Z", "145556Z WAN failover took 22.4s and haproxy failed to failover"),
    (r"lockless IPAM", "SQLite WAL uses serialized immediate locking, not lockless concurrency"),
    (r"without a single point of failure", "Floating IP and single SQLite instance are architectural single points of failure"),
    (r"zero stale ARP", "Stale ARP clearance requires quarantine cooldown"),
]

def check_forbidden_phrases():
    errors = []
    files_to_check = [ROOT / "README.md", ROOT / "bench" / "README.md"] + list(DOCS_DIR.glob("*.md"))
    for file_path in files_to_check:
        if not file_path.is_file():
            continue
        content = file_path.read_text(encoding="utf-8")
        for pattern, reason in FORBIDDEN_PHRASES:
            for match in re.finditer(pattern, content, flags=re.IGNORECASE):
                lineno = content[:match.start()].count("\n") + 1
                errors.append(f"{file_path.relative_to(ROOT)}:{lineno}: Found forbidden claim '{match.group(0)}' ({reason})")
    return errors

def check_markdown_summary_links():
    errors = []
    files_to_check = [ROOT / "README.md", ROOT / "bench" / "README.md"] + list(DOCS_DIR.glob("*.md"))
    link_re = re.compile(r"\[([^\]]+)\]\(([^)]*summary\.json)\)")
    
    for file_path in files_to_check:
        if not file_path.is_file():
            continue
        content = file_path.read_text(encoding="utf-8")
        for match in link_re.finditer(content):
            target = match.group(2)
            # Resolve relative link
            resolved = (file_path.parent / target).resolve()
            if not resolved.is_file():
                errors.append(f"{file_path.relative_to(ROOT)}: Link to summary JSON missing: {target} (resolved to {resolved})")
    return errors

def check_dashboard_committed_benchmarks():
    errors = []
    if not DASHBOARD_BENCHMARKS.is_file():
        errors.append(f"Dashboard benchmark data file not found: {DASHBOARD_BENCHMARKS}")
        return errors

    content = DASHBOARD_BENCHMARKS.read_text(encoding="utf-8")
    
    # Extract runs: id, status
    run_block_re = re.compile(r"id:\s*'(t[1-7]_[^']+)',\s*suite_id:\s*'[^']+',\s*status:\s*'([^']+)'", re.MULTILINE)
    matches = run_block_re.findall(content)
    if not matches:
        errors.append("No benchmark runs parsed from committedBenchmarks.ts")
        return errors

    for run_id, status in matches:
        summary_file = BENCH_RAW_DIR / f"{run_id}_summary.json"
        if not summary_file.is_file():
            errors.append(f"committedBenchmarks.ts: Run id '{run_id}' has no matching summary file at {summary_file}")
            continue

        try:
            with open(summary_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            errors.append(f"Failed to parse JSON for {summary_file}: {e}")
            continue

        raw_status = data.get("status", "").upper()
        if raw_status == "FAILED" and status != "failed":
            errors.append(f"committedBenchmarks.ts: Run '{run_id}' has raw status FAILED but dashboard records status '{status}'")
        elif raw_status in ("PASSED", "EXECUTED", "COMPLETED") and status == "failed":
            # Check if partial failure or overall success
            pass

    return errors

def main():
    print("Checking documentation claims and benchmark traceability...")
    all_errors = []
    
    forbidden_errs = check_forbidden_phrases()
    if forbidden_errs:
        all_errors.extend(forbidden_errs)
        
    link_errs = check_markdown_summary_links()
    if link_errs:
        all_errors.extend(link_errs)
        
    dashboard_errs = check_dashboard_committed_benchmarks()
    if dashboard_errs:
        all_errors.extend(dashboard_errs)

    if all_errors:
        print(f"\nFAILED: {len(all_errors)} claim / evidence inconsistencies found:")
        for err in all_errors:
            print(f"  - {err}")
        sys.exit(1)

    print("SUCCESS: All claims are traceable to committed benchmark summaries with no forbidden assertions.")
    sys.exit(0)

if __name__ == "__main__":
    main()
