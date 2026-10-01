#!/usr/bin/env python3
"""Preserve failed-run mail, then use only public dismissal on exact owned paths."""
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path
import sys
from live_support import Live, sha

run = Live(sys.argv[1], sys.argv[2])
run.baseline()
rows = []
for actor in run.context["actors"]:
    copies = run.evidence / "cards" / actor["label"]
    copies.mkdir(parents=True)
    for folder in ("new", "cur"):
        for card in (run.state / actor["address"] / folder).glob("*"):
            if card.is_file():
                (copies / (folder + "-" + card.name)).write_bytes(card.read_bytes())
    output = run.checked("inbox", "--as", actor["address"])
    cards = []
    for line in output.splitlines():
        path = Path(line.split("\t", 1)[0])
        assert path.resolve().is_relative_to(run.state / actor["address"])
        msg = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
        cards.append(dict(path=str(path), sha256=sha(path), message_id=msg["Message-ID"],
                          work=msg["X-Work"], type=msg["X-Type"], state=msg["X-State"]))
    rows.append(dict(actor=actor["label"], address=actor["address"], expected="empty actionable inbox", cards=cards))
(run.evidence / "before.json").write_text(json.dumps(rows, indent=2) + "\n")
if len(sys.argv) == 4 and sys.argv[3] in ("--dismiss", "--cleanup"):
    for row in rows:
        for card in row["cards"]:
            assert card["work"].startswith(("live-", "fresh-")), "not an owned test work ID"
            if sys.argv[3] == "--cleanup" and card["type"] in ("question", "decision"):
                code, out, err = run.reach("reply", "--as", row["address"], "--card", card["path"], "--state", "refused",
                    text="Observer fixture cleanup outside measured journey. No acceptance credit.\n")
            else:
                code, out, err = run.reach("dismiss", "--as", row["address"], "--card", card["path"], "--reason", "failed test fixture cleanup")
            card["dismiss"] = dict(exit_code=code, output=out, error=err)
        row["remaining"] = run.checked("inbox", "--as", row["address"])
    if sys.argv[3] == "--cleanup":
        for row in rows:
            output = run.checked("inbox", "--as", row["address"])
            for line in output.splitlines():
                path = Path(line.split("\t", 1)[0])
                assert path.resolve().is_relative_to(run.state / row["address"])
                msg = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
                if msg["X-Type"] not in ("question", "decision"):
                    assert msg["X-Work"].startswith(("live-", "fresh-"))
                    run.checked("dismiss", "--as", row["address"], "--card", str(path), "--reason", "fixture cleanup report")
            row["remaining"] = run.checked("inbox", "--as", row["address"])
    (run.evidence / "after.json").write_text(json.dumps(rows, indent=2) + "\n")
    print(json.dumps(rows, indent=2))
    raise SystemExit(any(row["remaining"].strip() for row in rows))
print(json.dumps(rows, indent=2))
