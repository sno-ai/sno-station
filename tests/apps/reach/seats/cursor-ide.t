#!/usr/bin/env bash
# A Cursor IDE chat as a Reach seat: register from the chat's environment, a card sent to it is
# handed over by `sno reach cursor-hook stop` as the next user message, the prompt hook carries
# the reminder, an idle stop returns the keep-alive, and an ended chat is not rung.
# Hook input is the IDE 3.24.9 stop event recorded on 2026-10-09 (cursor-station T2).
# The stop hook's timeout is shortened to 40 s here, so the keep-alive arrives after 30 s.
set -Eeuo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
public="${REACH_UNDER_TEST:-$here/../../../../apps/reach/bin/sno-reach}"
python3 - "$public" <<'PY'
import json, os, pathlib, subprocess, sys, tempfile, time
reach = sys.argv[1]
proof = pathlib.Path(tempfile.mkdtemp(prefix='reach-cursor-ide.'))
print('evidence:', proof, flush=True)
host = subprocess.check_output(['hostname'], text=True).strip()
base = {k: v for k, v in os.environ.items() if not k.startswith(('CURSOR_', 'SNO_REACH_', 'CLAUDECODE'))}
base |= {'SNO_REACH_CURSOR_STOP_WAIT': '40', 'HOME': str(proof / 'home'), 'SNO_REACH_ROOT': str(proof / 'state'), 'SNO_PROFILE_DIR': str(proof / 'profile')}
(proof / 'home').mkdir()
conversations = proof / 'profile/cursor/conversations'; conversations.mkdir(parents=True)
chat, idle_chat = '11111111-2222-4333-8444-555555555555', '7a1c0de0-0000-4000-8000-00000000idle'
seat, idle_seat, sender = f'executor.ide@{host}', f'executor.idle@{host}', f'pl.sender@{host}'
stop_input = {"conversation_id": chat, "generation_id": "473a9b98-f2ad-412a-8317-490191f19b8e",
    "model": "cursor-grok-4.6-medium", "status": "completed", "loop_count": 0, "session_id": chat,
    "hook_event_name": "stop", "cursor_version": "3.24.9",
    "workspace_roots": ["/work/repoA", "/work/repoB"],
    "transcript_path": f"/work/.cursor/projects/work-repoA/agent-transcripts/{chat}/{chat}.jsonl"}
def hook_input(conversation, event='stop'):
    return json.dumps(dict(stop_input, conversation_id=conversation, session_id=conversation, hook_event_name=event))
def run(args, env=base, stdin=None, timeout=30):
    return subprocess.run([reach, *args], env=env, input=stdin, capture_output=True, text=True, timeout=timeout)
def record(conversation, ended=None):
    (conversations / f'{conversation}.json').write_text(json.dumps({"conversation_id": conversation, "surface": "ide",
        "project": "/p", "workspace_roots": ["/p"], "model": "cursor-grok-4.6-medium", "reach_addr": None,
        "ended_at": ended}))
def ide_env(conversation):
    # An IDE agent's shell: CURSOR_AGENT and the conversation id, no CURSOR_INVOKED_AS; a Cursor
    # opened from a Claude Code shell also inherits CLAUDECODE.
    return base | {'CURSOR_AGENT': '1', 'CURSOR_CONVERSATION_ID': conversation, 'CLAUDECODE': '1'}
def background_stop(conversation):
    path = proof / f'stop-{conversation}.json'; path.write_text(hook_input(conversation))
    return subprocess.Popen([reach, 'cursor-hook', 'stop'], env=base, stdin=path.open(), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
def hook(event, conversation, env=base, timeout=30):
    started = time.monotonic()
    result = run(['cursor-hook', event], env=env, stdin=hook_input(conversation), timeout=timeout)
    assert result.returncode == 0, (event, result.returncode, result.stderr)
    return json.loads(result.stdout), time.monotonic() - started
for address, name in ((seat, 'IDE'), (idle_seat, 'Idle'), (sender, 'Sender')):
    subprocess.run([reach, 'init', '--as', address, '--name', name], env=base, check=True, capture_output=True, timeout=10)

# Register from inside the chat: no --channel, the conversation is the seat.
for address, conversation in ((seat, chat), (idle_seat, idle_chat)):
    result = run(['register', '--as', address], env=ide_env(conversation))
    assert result.returncode == 0, result.stderr
    record(conversation)
reachable = json.loads((proof / 'state' / seat / 'reachable.json').read_text())
assert reachable['channel'] == 'cursor-ide' and reachable['identity'] == {'kind': 'cursor-conversation', 'value': chat}, reachable
assert reachable['harness'] == 'cursor', reachable
print('PASS: register from an IDE chat records channel cursor-ide, the conversation id and harness cursor', flush=True)

# The idle seat's stop runs the whole wait in the background; it must end in the keep-alive.
idle = background_stop(idle_chat)
idle_started = time.monotonic()

# A person pressed stop: no wait and no keep-alive, even for a seat.
aborted = run(['cursor-hook', 'stop'], stdin=json.dumps(dict(json.loads(hook_input(chat)), status='aborted')), timeout=30)
assert aborted.returncode == 0 and json.loads(aborted.stdout) == {}, (aborted.stdout, aborted.stderr)
print('PASS: an aborted stop of a seat returns {} at once', flush=True)
answer, took = hook('stop', 'not-a-seat-conversation')
assert answer == {} and took < 10, (answer, took)
answer, _ = hook('prompt', 'not-a-seat-conversation')
assert answer == {}, answer
print('PASS: a conversation that is not a seat gets {} from both hooks at once', flush=True)

# A stop that is already waiting picks up a card sent while it waits.
waiting = background_stop(chat)
time.sleep(3)
# The hook replaces the sno-reach process instead of running under its 290 s deadline.
command = pathlib.Path(f'/proc/{waiting.pid}/cmdline').read_bytes().split(b'\0')
assert any(part.endswith(b'/lib/reach-cursor-hook') for part in command), command
card = '\n'.join([f'From: Sender <{sender}>', f'To: {seat}', 'Subject: [QUESTION] review the README',
    'Date: ' + time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime()), f'Message-ID: <cursor-ide-1@{host}>',
    'X-Work: cursor-ide-review', 'X-Type: question', '', 'CARD-BODY-7Q: review README.md and answer.', ''])
sent = run(['send', '--as', sender], stdin=card)
assert sent.returncode == 0, sent.stderr
assert 'notification rang-unverified' in sent.stderr, sent.stderr
out, err = waiting.communicate(timeout=30)
assert waiting.returncode == 0, err
followup = json.loads(out)['followup_message']
assert 'CARD-BODY-7Q' in followup and f'<cursor-ide-1@{host}>' in followup, followup
assert f'Seat: {seat}' in followup and f'Card: {proof}/state/{seat}/new/' in followup, followup
print('PASS: a card sent while the stop hook waits is returned as followup_message with its path and text', flush=True)
# The next stop of the same chat must not hand the same card over again.
again = background_stop(chat)

# The card was handed over once: the prompt hook now carries the seen-but-not-accepted reminder.
answer, _ = hook('prompt', chat, env=ide_env(chat))
assert 'is seen but not accepted' in answer['additional_context'], answer
print('PASS: the prompt hook finds the IDE seat by conversation_id and returns the reminder as additional_context', flush=True)

result = run(['call', seat, 'hello'])
assert result.returncode == 3 and 'cursor-ide does not support call' in result.stderr, (result.returncode, result.stderr)
print('PASS: call refuses an IDE seat', flush=True)

# An ended chat is not rung; the card still lands in its inbox.
record(chat, ended='2026-10-10T02:00:00.000Z')
sent = run(['send', '--as', sender], stdin=card.replace('cursor-ide-1@', 'cursor-ide-2@'))
assert sent.returncode == 0 and 'notification failed' in sent.stderr, sent.stderr
assert any('cursor-ide-2@' in p.read_text() for p in (proof / 'state' / seat / 'new').iterdir())
print('PASS: a card to an ended IDE chat is delivered to the inbox and its ring reports failure', flush=True)

out, err = idle.communicate(timeout=300)
waited = time.monotonic() - idle_started
assert idle.returncode == 0, err
assert json.loads(out)['followup_message'].startswith('[Sno Reach keep-alive]\n'), out
assert waited >= 28, waited
out, err = again.communicate(timeout=60)
assert again.returncode == 0 and f'<cursor-ide-1@{host}>' not in json.loads(out)['followup_message'], out
print('PASS: a card handed over once is not handed over again', flush=True)
print(f'PASS: an idle IDE seat gets the keep-alive after {waited:.0f}s', flush=True)
PY
