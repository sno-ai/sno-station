"""Named fault plants in private installed copies, never the retained candidate."""
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import uuid
from live_support import manifest


@contextmanager
def variant(run, defect):
    current = run.home / ".local/lib/sno-reach/current"
    if current.resolve() != Path(run.context["release"]).resolve():
        raise RuntimeError("private current does not point to retained candidate")
    if defect == "none":
        yield
        return
    target = Path(run.context["run"]) / "variants" / (defect + "-" + uuid.uuid4().hex)
    shutil.copytree(run.context["release"], target)
    path = target / "bin/sno-reach"
    if defect == "send-ring":
        before = '[[ "$no_ring" == yes ]] || ring_delivered "$root" "$CALLER" "$input_file"'
        after = ': # test plant: delivery remains, send ring omitted'
    elif defect == "reply-ring":
        before = 'ring_delivered "$root" "$CALLER" "$reply_input"'
        after = ': # test plant: reply delivery remains, reverse ring omitted'
    elif defect == "reply-to":
        source = path.read_text().splitlines()
        matches = [line for line in source if line.strip().startswith("if awk ") and "then header=reply-to; fi" in line]
        if len(matches) != 1:
            raise RuntimeError("Reply-To resolver seam is not unique")
        before, after = matches[0], '    : # test plant: resolver always uses From'
    elif defect == "call-read":
        path = target / "lib/reach-call-acp.sh"
        before = '        if [[ "$output" == *"$delivery_receipt"* ]] &&'
        after = '        output="" # test plant: actual prompt completed, caller loses output\n' + before
    elif defect == "watch-prompt":
        path = target / "lib/reach-watch"
        before = '    offset="$(stat -c %s "$stream")"'
        after = ('    printf "Unexpected watch prompt: output WATCH-PLANT.\\n" | timeout -k 2 10 acpx --cwd "$cwd" --approve-all --format json --timeout 8 "$agent" prompt -s "$name" --no-wait --file - >/dev/null\n' + before)
    elif defect == "call-read-tmux":
        path = target / "lib/reach-call"
        # Since 2.0.4 a spawned seat's call is verified from its agent transcript, not the screen.
        before = '\t\t\ttext="$(transcript_text "$file" "$offset")"\n'
        after = before + '\t\t\ttext="" # test plant: keep send, drop the transcript read\n'
    elif defect == "remind-deadline":
        before = 'timeout --signal=KILL "$remaining" "$REPO_ROOT/lib/reach-remind" "$CALLER" || rc=$?'
        after = '"$REPO_ROOT/lib/reach-remind" "$CALLER" || rc=$? # test plant: whole-call deadline omitted'
    else:
        raise RuntimeError("unknown installed fault plant")
    text = path.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f"fault seam is not unique: {defect}")
    path.chmod(path.stat().st_mode | 0o200)
    path.write_text(text.replace(before, after, 1))
    code, _, error = run.command(["bash", "-n", str(path)])
    if code:
        raise RuntimeError("fault plant is not syntactically valid: " + error)
    (run.evidence / (defect + "-variant.json")).write_text(json.dumps(dict(
        retained=run.context["payload"], variant=manifest(target), changed_file=str(path.relative_to(target))), indent=2) + "\n")
    current.unlink()
    current.symlink_to(target)
    try:
        yield
    finally:
        current.unlink()
        current.symlink_to(run.context["release"])
        run.baseline()
