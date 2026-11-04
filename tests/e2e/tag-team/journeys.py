"""User-visible release promises, driven through installed real agent CLIs."""
import email
import json
import re
import socket
import time
import uuid

from fixture import SKILLS, SNO


def pair(f, variant):
    order = {"two-vendors": "claude-code,codex", "claude-only": "claude-code", "codex-only": "codex"}[variant]
    (f.home / ".config/sno/models.toml").write_text('[models]\nhandoff_order=' + json.dumps(order) + '\n')
    # Single-vendor means only that vendor is actually logged in in this private home.
    if variant == "claude-only":
        (f.home / ".codex/auth.json").unlink(missing_ok=True)
    if variant == "codex-only":
        (f.home / ".claude/.credentials.json").unlink(missing_ok=True)
    task = ("Implement integer addition as def add(a, b) in add.py in this scratch project and have the second agent review it. "
            "Check add(2, 3)==5 and add(-2, 2)==0 using Python. The implementer sends changed paths and checks to its "
            "assigned reviewer through Reach. The reviewer reads add.py and returns concrete findings or an explicit "
            "no-defect review through Reach. Do not commit or ask questions. Complete this tiny task.")
    result = f.sno("reach", "pair", task, timeout=240)
    (f.root / "pair-output.txt").write_text(result.stdout + result.stderr)
    seats = list((f.root / "reach").glob("executor.*"))
    for seat in seats:
        meta = seat / "reachable.json"
        if meta.exists():
            pane = json.loads(meta.read_text()).get("identity", {}).get("value")
            if pane and pane.startswith("%"):
                f.screen(pane, seat.name.split("@")[0])
    assert result.returncode == 0, result.stdout[-1800:] + result.stderr[-1800:]
    assert (f.project / "add.py").is_file(), "Implementer's result file is missing"
    f.run(["python3", "-c", "from add import add; assert add(2,3)==5; assert add(-2,2)==0"], check=True)
    impl = next(p for p in seats if "-impl@" in p.name)
    review = next(p for p in seats if "-review@" in p.name)
    runtimes = [json.loads((p / "seat.json").read_text())["runtime"] for p in (impl, review)]
    expected = {"two-vendors": ["claude", "codex"], "claude-only": ["claude", "claude"],
                "codex-only": ["codex", "codex"]}[variant]
    assert runtimes == expected, runtimes
    reviews = []
    for directory in ("new", "cur"):
        for p in (impl / directory).glob("*"):
            message = email.message_from_bytes(p.read_bytes())
            if review.name in message.get("From", "") and message.get("X-Type") == "answer":
                body = message.get_payload(decode=True).decode()
                reviews.append("\n".join(line for line in body.splitlines() if not line.startswith(">")))
    assert any("add.py" in body and re.search(r"no defects?|finding|review|passed", body, re.I) for body in reviews), reviews
    if variant != "two-vendors":
        assert "Both agents use" in result.stdout and "no cross-vendor review" in result.stdout, result.stdout
    (f.root / "review.json").write_text(json.dumps(reviews, indent=2))
    return dict(runtimes=runtimes, output="add.py: 5 and 0", review=reviews)


def segment(f, label):
    # Invoke the exact installed status-line command with ordinary host status input.
    settings = json.loads((f.home / ".claude/settings.json").read_text())
    command = settings["statusLine"]["command"]
    result = f.run(["bash", "-c", command], input=json.dumps({"session_id": "status-observer", "cwd": str(f.project)}), check=True)
    (f.root / (label + "-segment.txt")).write_text(result.stdout)
    assert "need you" in result.stdout and re.search(r"approve|permission", result.stdout, re.I), result.stdout
    return result.stdout


def squad_screen(f, session, label):
    pane = f.mux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "fixture", str(SNO) + " squad").stdout.strip()
    try:
        text = f.until(lambda: (t if "q/Escape exit" in (t := f.screen(pane, label)) else None), "full-screen squad view", 15)
        assert session in text and "Needs you" in text and "permission to approve" in text, text
        return text
    finally:
        f.mux("send-keys", "-t", pane, "q")


def state(f, agent):
    prompt = ("Use the shell tool to run exactly: python3 -c \"from pathlib import Path; "
              "Path('permission-proof.txt').write_text('approved\\n')\". "
              "Do not substitute another tool or ask a text question. After it succeeds, reply exactly: Approved operation complete.")
    pane = f.launch(agent, prompt, permission=True)
    permission = re.compile(r"Do you want to (?:proceed|allow|run)|Allow (?:this|Claude)|Would you like to run|Yes, proceed", re.I)
    try:
        f.until(lambda: permission.search(f.screen(pane, "permission-ui")), "actual " + agent + " permission prompt", 90)
        assert not (f.project / "permission-proof.txt").exists(), "Permission was bypassed"
        # The permission hook can finish writing just after the prompt is drawn.
        waiting = f.until(lambda: [r for r in f.view("permission-view")["agents"]
                                   if r["harness"] == agent and r["waitingForHuman"] == "yes"] or None,
                          "permission observation recorded", 15)
        assert len(waiting) == 1, waiting
        row = waiting[0]
        assert row["group"] == "Needs you" and row["waitingReason"] == "permission to approve", row
        segment(f, "permission")
        squad_screen(f, row["sessionId"], "permission-full-screen")
        # The agent may ask for other approvals (such as its task brief) first; approve each prompt shown.
        def approve(done):
            if re.search(r"Do you want to|Would you like to", f.mux("capture-pane", "-p", "-t", pane).stdout):
                f.mux("send-keys", "-t", pane, "Enter")
                time.sleep(1)
            return done()
        f.until(lambda: approve(lambda: (f.project / "permission-proof.txt").exists()), "approved command wrote real file", 90)
        f.until(lambda: approve(lambda: any("Approved operation complete." in text for text in f.replies(agent))), "agent final reply", 60)
        session = row["sessionId"]
        row = f.until(lambda: next((r for r in f.view("finished-view")["agents"]
                      if r["sessionId"] == session and r["harness"] == agent and r["group"] == "Finished"), None),
                      "native stop hook records finished agent", 30)
        assert row["group"] == "Finished" and row["waitingForHuman"] == "no", row
        assert (f.project / "permission-proof.txt").read_text() == "approved\n"
        return dict(waiting=waiting[0], finished=row)
    finally:
        f.screen(pane, "state-final-ui")


def cursor_status(f):
    # A real Claude permission request supplies the other-agent state Cursor must display.
    pane = f.launch("claude", "Run exactly this Bash command: touch cursor-observed.txt. Then reply done.", permission=True)
    f.until(lambda: re.search(r"Do you want to|Allow this|Allow Claude", f.screen(pane, "claude-permission")), "Claude permission wait", 75)
    view = f.view("cursor-other-agent-view")
    assert any(r["waitingReason"] == "permission to approve" for r in view["agents"]), view
    codex = f.launch("codex", "Use the shell tool to run exactly: python3 -c \"from pathlib import Path; Path('codex-observed.txt').write_text('approved')\". This operation requires write access; if the sandbox refuses, request permission and wait for approval. Do not substitute another tool.", permission=True)
    f.until(lambda: re.search(r"Would you like to run|Yes, proceed", f.screen(codex, "codex-permission")), "Codex permission wait", 75)
    observed = f.view("both-agent-permissions")
    assert {r["harness"] for r in observed["agents"] if r["waitingReason"] == "permission to approve"} == {"claude", "codex"}, observed
    observer = f.launch("claude", "Reply exactly: Observer ready.")
    f.until(lambda: re.search(r"2 need you.*(?:approve|permission)", f.screen(observer, "claude-actual-status-ui")),
            "actual Claude status line displays both agents needing permission", 60)
    cursor = f.launch("cursor")
    text = f.until(lambda: t if "need you" in (t := f.screen(cursor, "cursor-status-ui")) else None,
                   "actual Cursor status line displays another agent's permission wait", 90)
    assert re.search(r"approve|permission", text, re.I), text
    return dict(actual_claude_status_line=True, actual_cursor_status_line=True, both_native_permission_waits=True, proxy_variables_removed=True)


def seed_lesson(f):
    scripts = SKILLS / "skills/R-recursive-self-improvement/rem-reflect/skill/scripts"
    code = """
import {initializeStore,emptyState,git} from STORE;
import {appendRows} from LESSONS;
import {mkdirSync} from 'node:fs';
const root=process.env.REM_REFLECT_STORE, home=process.env.HOME;
mkdirSync(root,{recursive:true});
initializeStore(root,{claude_home:home+'/.claude',codex_home:home+'/.codex',hermes_home:home+'/.hermes',
openclaw_home:home+'/.openclaw',claude_root:home+'/.claude/projects',codex_root:home+'/.codex/sessions',
cursor_root:home+'/.cursor',project_names:{},time_zone:'UTC'},emptyState());
appendRows(root+'/wiki/lessons.jsonl',[{lesson_id:'L-tag-team-report',page_id:'pg-tag-team',status:'candidate',listed:true,
count:2,helped:0,harmful:0,measured:false,created_run:'20261103-0000',project_id:'fixture',agent_id:'claude-code',
user_id:'fixture',skill_target:null,applies_to:'general',
situation:{task_type:'file processing',trigger:'report a sum task',tools:['Bash']},
scenario:{task_type:'file processing',trigger:'report a sum task',tools:['Bash']},
advice:"When replying about a sum task, begin with exactly 'Verified result:'.",
because:'The task report must identify a verified result.',expected_result:"Every sum task reply starts with 'Verified result:'.",
success_criteria:"The next ordinary sum task reply begins with 'Verified result:'.",memory_fact_ids:[],polarity:'from_failure',
evidence:[],counter_examples:'not searched'}]);
git(root,['add','config.json','state.json','.gitignore','wiki/lessons.jsonl']);git(root,['commit','-qm','Fixture lesson']);
""".replace("from STORE;", "from " + json.dumps((scripts / "store.ts").as_uri()) + ";").replace("from LESSONS;", "from " + json.dumps((scripts / "lessons.ts").as_uri()) + ";")
    f.run([f.node, "--experimental-strip-types", "--input-type=module", "-e", code], check=True)


def lesson(f, agent):
    seed_lesson(f)
    pane = f.launch(agent, "This is a sum task. Compute 13 + 29 + 8 mentally, reply briefly and wait. Do not use tools or edit files.")
    try:
        f.until(lambda: any("50" in text for text in f.replies(agent)), "initial real reply before approval", 80)
        before = len(f.replies(agent))
        # Approval uses the real local command; the fixture only supplies a candidate.
        detail = f.sno("rem-reflect", "lesson", "L-tag-team-report", "--cwd", f.project,
                       "--agent", "claude-code" if agent == "claude" else "codex", timeout=15, check=True)
        (f.root / "lesson-detail.txt").write_text(detail.stdout + detail.stderr)
        assert "Every sum task reply" in detail.stdout and "next ordinary sum task reply" in detail.stdout, detail.stdout
        accepted = f.sno("rem-reflect", "accept", "L-tag-team-report", "--all-projects", timeout=45, check=True)
        (f.root / "approval-output.txt").write_text(accepted.stdout + accepted.stderr)
        assert "L-tag-team-report: accepted" in accepted.stdout, accepted.stdout
        f.send(pane, "Report whether this sum task is ready; leave files unchanged.")
        reply = f.until(lambda: next((t for t in f.replies(agent)[before:] if t.strip().startswith("Verified result:")), None),
                        "same-session next reply follows approved lesson without restatement", 85)
        after_compact = None
        if agent == "codex":
            f.send(pane, "/compact")
            f.until(lambda: compacted(f, agent), "approved-lesson conversation actually compacted", 75)
            before = len(f.replies(agent))
            f.send(pane, "Report whether this sum task is ready; leave files unchanged.")
            after_compact = f.until(lambda: next((t for t in f.replies(agent)[before:]
                if t.strip().startswith("Verified result:")), None), "approved lesson applies again after compaction", 60)
            assert "invalid PostCompact hook JSON output" not in f.screen(pane, "lesson-postcompact-ui")
        sessions = {r.get("sessionId") for r in f.view("lesson-view")["agents"] if r["harness"] == agent}
        assert len(sessions) == 1, sessions
        return dict(next_reply=reply, postcompact_reply=after_compact, sessions=list(sessions),
                    expected_result_shown=True, success_criteria_shown=True)
    finally:
        f.screen(pane, "lesson-final-ui")


def compacted(f, agent):
    rows = f.transcripts(agent)
    if agent == "claude":
        return any(r.get("type") == "system" and r.get("subtype") == "compact_boundary" for r in rows)
    return any(r.get("type") == "compacted" or
               (r.get("type") == "event_msg" and r.get("payload", {}).get("type") == "context_compacted") for r in rows)


def continuity(f, agent, variant):
    (f.project / "numbers.csv").write_text("13,29,8\n")
    prompt = ("Work on this disposable sum task; do not commit. First run cat absent-input.txt once and keep its actual failure. "
              "The authorized unfinished action is to read numbers.csv, sum its comma-separated integers and write the decimal sum "
              "plus newline to result.txt. Do not perform that action in this first turn. Preserve the task using the installed "
              "continuity instructions, including its failed operation and expected result, then pause. "
              "Reply READY_FOR_CONTINUATION when your task record is saved and you are waiting. Do not ask questions.")
    pane = f.launch(agent, prompt)
    try:
        f.until(lambda: any("READY_FOR_CONTINUATION" in t for t in f.replies(agent)), "agent paused with unfinished task", 95)
        briefs = list((f.profile / "station/handoff").glob("*.md"))
        if len(briefs) == 1:
            brief = briefs[0]
            assert "absent-input" in brief.read_text() and "numbers.csv" in brief.read_text(), brief.read_text()
        else:
            rows = [r for r in f.view("unfinished-task-view")["agents"] if r["harness"] == agent]
            assert len(rows) == 1, rows
            brief = f.profile / "station/handoff" / (rows[0]["sessionId"] + ".md")
            print("defect: agent did not save its readable continuity brief", flush=True)
        assert not (f.project / "result.txt").exists(), "Next action was already performed before interruption"
        if brief.exists():
            (f.root / "unfinished-brief.md").write_text(brief.read_text())
        if variant == "compact":
            f.send(pane, "/compact")
            f.until(lambda: compacted(f, agent), "real /compact created a native compaction boundary", 95)
            before = len(f.replies(agent))
            f.send(pane, "Continue.")
            f.until(lambda: (f.project / "result.txt").exists(), "postcompact agent completed original next action", 70)
            f.until(lambda: any(re.search(r"result\.txt|completed|finished", t, re.I) for t in f.replies(agent)[before:]),
                    "postcompact completion reply", 30)
            assert "absent-input" in brief.read_text() and "No such file or directory" in brief.read_text(), "Compaction lost the actual earlier failure"
            text = f.screen(pane, "postcompact-ui")
            assert "invalid PostCompact hook JSON output" not in text, "Native Codex rejected the product PostCompact hook JSON; the task file was completed but postcompact context delivery failed"
            recovery = "native /compact boundary and same conversation"
        else:
            f.mux("kill-pane", "-t", pane)
            pane = None
            if agent == "codex":
                f.stop_codex()
            result = f.sno("rotate-agent-resume", "--to", "claude-code" if agent == "claude" else "codex",
                           "--cwd", f.project, "--checkpoint", brief, "--work", "tag-team-sum", timeout=160)
            recovery = result.stdout
            (f.root / "recovery-output.txt").write_text(result.stdout + result.stderr)
            assert result.returncode == 0, result.stderr + result.stdout
            assert re.search(r"resumed next_action=completed", result.stdout), result.stdout
            assert "absent-input" in result.stdout, result.stdout
            assert "session=" + brief.stem in result.stdout, "Recovery did not identify the original conversation"
        assert (f.project / "result.txt").read_text() == "50\n"
        assert brief.exists(), "Native task/compaction ran, but the product never saved its readable continuity brief"
        return dict(recovery=recovery, output="50\n", retained_failure="absent-input.txt", actual_compact=variant == "compact")
    finally:
        if pane:
            f.screen(pane, "continuity-final-ui")


def mailbox(f, agent, variant):
    address = "worker.tag-team-" + uuid.uuid4().hex[:10] + "@" + socket.gethostname()
    f.sno("reach", "init", "--as", address, "--name", "Receiver", check=True)
    f.sno("reach", "spawn", agent, "--as", address, "--cwd", f.project, "--window", timeout=50, check=True)
    seat = f.root / "reach" / address
    pane = json.loads((seat / "reachable.json").read_text())["identity"]["value"]
    try:
        f.until(lambda: f.replies(agent), "real receiver completed startup", 75)
        nonce = uuid.uuid4().hex
        # The content-derived output is absent from every later inbox cue.
        payload = ("Read this complete original call. Write pickup.txt containing exactly " + nonce +
                   ". Then output PICKED_UP " + nonce + ".\n" +
                   ("Context line " + nonce + "; preserve all characters.\n") * 120 + "END " + nonce + "\n\n")
        if variant == "typing":
            f.mux("send-keys", "-t", pane, "-l", "--", "unfinished-person-draft")
            f.until(lambda: "unfinished-person-draft" in f.screen(pane, "typing-before-call"), "receiver has unsent user input", 10)
        else:
            f.send(pane, "/compact")
            # Send immediately after the client's actual compaction command, like the existing real helper.
        result = f.sno("reach", "call", address, payload, "--expect", "PICKED_UP " + nonce,
                       "--timeout", "3", "--every", "1", timeout=12)
        (f.root / "call-output.txt").write_text(result.stdout + result.stderr)
        assert result.returncode in (0, 3, 4), result.stdout + result.stderr
        stored = []
        for directory in ("new", "cur"):
            for path in (seat / directory).glob("*"):
                body = path.read_bytes()
                delimiter = b"\n\nOriginal call text:\n"
                if delimiter in body and body.split(delimiter, 1)[1] == payload.encode():
                    stored.append(path)
        assert len(stored) == 1, "Complete original call bytes were not stored exactly once"
        (f.root / "original-call.mail").write_bytes(stored[0].read_bytes())
        if variant == "typing":
            assert "unfinished-person-draft" in f.screen(pane, "typing-after-call"), "Call damaged the unsent draft"
            f.mux("send-keys", "-t", pane, "C-u")
        else:
            f.until(lambda: compacted(f, agent), "receiver actually compacted", 95)
        if not (f.project / "pickup.txt").exists():
            f.send(pane, "Read your inbox and open each exact returned call-mail file. Handle the pending original instruction completely.")
        f.until(lambda: (f.project / "pickup.txt").exists(), "receiver independently read mail and acted", 90)
        assert (f.project / "pickup.txt").read_text().strip() == nonce
        f.until(lambda: any("PICKED_UP " + nonce in t for t in f.replies(agent)), "content-derived receiver answer", 20)
        transcript = json.dumps(f.transcripts(agent))
        assert "sno reach inbox" in transcript, "Receiver did not use the real inbox entry"
        return dict(call_exit=result.returncode, exact_bytes=len(payload.encode()), stored=str(stored[0]),
                    reply="PICKED_UP " + nonce, actual_compact=variant == "compact")
    finally:
        f.screen(pane, "mailbox-final-ui")
