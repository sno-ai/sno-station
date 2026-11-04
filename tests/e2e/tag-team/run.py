#!/usr/bin/env python3
"""Run one named journey; no full-suite mode and no automatic retries."""
import argparse
import json
import time
import traceback

from fixture import Fixture, Unavailable
from journeys import pair, state, continuity, lesson, mailbox, cursor_status, brief_prompts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journey", choices=["pair", "state", "continuity", "lesson", "mailbox", "cursor-status"])
    parser.add_argument("--agent", choices=["claude", "codex"], default="claude")
    parser.add_argument("--variant", default=None)
    args = parser.parse_args()
    variants = {"pair": ("two-vendors", "claude-only", "codex-only"), "continuity": ("resume", "compact"),
                "mailbox": ("typing", "compact"), "state": ("permission", "brief-prompts"), "lesson": ("approval",),
                "cursor-status": ("status",)}
    variant = args.variant or variants[args.journey][0]
    if variant not in variants[args.journey]:
        parser.error("variant must be one of " + ", ".join(variants[args.journey]))
    agents = ("claude", "codex", "cursor") if args.journey == "cursor-status" else ("claude", "codex")
    f = Fixture(args.journey + "-" + args.agent + "-" + variant, agents=agents)
    started = time.monotonic()
    proof = dict(journey=args.journey, agent=args.agent, variant=variant, evidence=str(f.root))
    try:
        f.setup()
        if args.journey == "pair":
            proof["observed"] = pair(f, variant)
        elif args.journey == "state":
            proof["observed"] = state(f, args.agent) if variant == "permission" else brief_prompts(f, args.agent)
        elif args.journey == "continuity":
            proof["observed"] = continuity(f, args.agent, variant)
        elif args.journey == "lesson":
            proof["observed"] = lesson(f, args.agent)
        elif args.journey == "mailbox":
            proof["observed"] = mailbox(f, args.agent, variant)
        else:
            proof["observed"] = cursor_status(f)
        proof["result"] = "passed"
    except Unavailable as e:
        proof.update(result="could not run", failure=str(e))
    except Exception:
        proof.update(result="failed", failure=traceback.format_exc())
    finally:
        try:
            f.close()
        except Exception:
            proof["cleanup_failure"] = traceback.format_exc()
            proof["result"] = "failed"
        proof["elapsed_seconds"] = round(time.monotonic() - started, 2)
        (f.root / "proof.json").write_text(json.dumps(proof, indent=2))
        print(json.dumps(proof), flush=True)
    return {"passed": 0, "failed": 1, "could not run": 2}[proof["result"]]


if __name__ == "__main__":
    raise SystemExit(main())
