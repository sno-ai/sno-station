#!/usr/bin/env python3
"""Execute the admitted Reach-only integration inventory; retain every result."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
CASES = []


def cases(script, modes):
    for mode in modes.split():
        CASES.append((f"{script}:{mode}", ["bash", str(HERE / script), mode]))


cases("public-contract.t", "surface init lint inbox wait reply")
cases("blank-options.t", "handle as idle")
cases("progress-eligibility.t", "expiry supersede reverse unheld")
for script in ("transport.t", "progress-reporting-lint.t",
               "local-delivery.t", "empty-body-refusal.t", "seat-ownership.t",
               "read-only.t", "send-preflight.t", "requires-action.t",
               "reply-routing.t"):
    CASES.append((script, ["bash", str(HERE / script)]))
cases("terminal-states.t", "completed-after failed-after cancelled-before cancelled-after refused-before refused-after")
cases("agent-mailbox-commands.t", """
test_real_dependencies_and_delivery_headers test_lint_rejects_ambiguous_contract_values
test_polling_scan_errors_surface_as_io_failure test_wait_surfaces_unreadable_listed_answer
test_reply_preserves_preexisting_cur_destination test_third_party_cannot_dismiss
test_cc_only_caller_cannot_reply test_bcc_caller_replies_from_delivered_copy
test_direct_answer_send_satisfies_wait test_uninvolved_answer_cannot_close_action
test_wait_isolated_by_recipient_thread_and_type test_reply_quotes_threads_and_records_only_success
test_strict_lint_and_zero_placement test_private_bcc_dismissal
test_sender_declared_no_reply_stops_at_delivery test_send_enforces_informational_recipient_fields
test_send_rate_limits_non_questions_per_pair
""")
cases("progress-reporting.t", "reply state reminder")
cases("reachability-wake.t", """
lifecycle wake-log-lock-held-unregister-bounds-out wake-child-descriptor-closure publication
outcomes reached-outcomes wake-start-failure doorbell-deadline executor-wake doorbell-measurement
confirmation retry-bound supervisor incident outbox-recovery outbox-partial-delivery
outbox-elapsed-only outbox-count-only outbox-mixed-supervisors outbox-stalled-flush
outbox-status-delivery-failure outbox-escalation-restart outbox-adopt-race outbox-sender-owned-state
outbox-late-delivery outbox-removed-mixed outbox-empty-entry outbox-final-boundaries
""")
CASES.append(("ACP integration", ["bash", str(HERE / "seats/acp-communication.t")]))
for script in ("default-environment.t", "wake-adopt-scale.t", "remote-protocol.t", "seats/call-tmux.t",
               "seats/call-real-tmux.t", "seats/call-foreign-pipe.t", "seats/call-short-popup.t", "seats/call-echo-receipt.t", "seats/registered-tmux.t",
               "seats/ring-reregistration.t", "seats/ring-real-tmux.t", "seats/ring-channel.t"):
    CASES.append((script, ["bash", str(HERE / script)]))
# Start the genuinely long, isolated groups first. The result order is stable.
priority = {"seats/ring-real-tmux.t": 0, "seats/call-tmux.t": 1, "ACP integration": 2}
CASES.sort(key=lambda row: priority.get(row[0], 4))


def identities():
    repo = HERE.parents[2]
    files = {}
    for root in (HERE, repo / "apps/reach"):
        for path in sorted(root.rglob("*")):
            if "__pycache__" in path.parts or "dist" in path.parts:
                continue
            if path.is_symlink():
                files[str(path.relative_to(repo))] = {"link": os.readlink(path)}
            elif path.is_file():
                files[str(path.relative_to(repo))] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                                     "mode": oct(path.stat().st_mode & 0o777)}
    return dict(head=subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(), files=files)


def main():
    if sys.argv[1:] == ["--list"]:
        for name, _ in CASES:
            print(name)
        return 0
    proof = Path(tempfile.mkdtemp(prefix="reach-local-suite-"))
    print(f"Reach local integration evidence: {proof}", flush=True)
    started = time.monotonic()
    before = identities()
    (proof / "inputs-before.json").write_text(json.dumps(before, indent=2) + "\n")
    env = dict(os.environ, REACHABILITY_WAKE_DEDICATED_TMUX="1")

    def run(item):
        index, (name, command) = item
        before = time.monotonic()
        with (proof / f"{index:03}.log").open("w") as log:
            try:
                result = subprocess.run(["timeout", "--kill-after=5", "120", *command],
                                        env=env, stdout=log, stderr=subprocess.STDOUT)
                code = result.returncode
            except OSError as error:
                log.write(str(error))
                code = 127
        row = dict(index=index, name=name, command=command, exit_code=code,
                   seconds=round(time.monotonic() - before, 3))
        print(json.dumps(row), flush=True)
        if code:
            print(f"FAILED CASE LOG: {name}\n{(proof / f'{index:03}.log').read_text()}", flush=True)
        return row

    timed = [item for item in enumerate(CASES)
             if item[1][0] in {"ACP integration", "reachability-wake.t:outbox-stalled-flush"}]
    assert [item[1][0] for item in timed] == [
        "ACP integration", "reachability-wake.t:outbox-stalled-flush"], "each isolated deadline group must occur exactly once"
    timed_indices = {item[0] for item in timed}
    parallel = [item for item in enumerate(CASES) if item[0] not in timed_indices]
    cpus = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    workers = min(6, max(1, cpus // 2))
    print(json.dumps(dict(host=os.uname().nodename, logical_cpus=cpus, parallel_workers=workers)), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(run, parallel))
    # Keep the unchanged three/four-second assertions outside our own parallel load.
    results.extend(run(item) for item in timed)
    results.sort(key=lambda row: row["index"])
    report = dict(host=os.uname().nodename, seconds=round(time.monotonic() - started, 3),
                  admitted=len(CASES), executed=len(results), results=results,
                  excluded="Physical SSH, installed startup, frozen-archive and live-agent proofs are separate; this is local source integration only.")
    after = identities()
    (proof / "inputs-after.json").write_text(json.dumps(after, indent=2) + "\n")
    report["unchanged_inputs"] = before == after
    (proof / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    return int(before != after or len(results) != len(CASES) or any(row["exit_code"] for row in results))


if __name__ == "__main__":
    raise SystemExit(main())
