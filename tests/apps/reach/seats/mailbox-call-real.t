#!/usr/bin/env bash
# Real Claude receiver, isolated home/profile/project and private tmux server.
set -Eeuo pipefail
scenario="${1:?usage: mailbox-call-real.t typing|compacting|handoff|handoff-card|handoff-acp}"
[[ "$scenario" == typing || "$scenario" == compacting || "$scenario" == handoff || "$scenario" == handoff-card || "$scenario" == handoff-acp ]] || exit 64
real_home="$HOME"
claude_source="${CLAUDE_CONFIG_DIR:-$real_home/.claude}"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../test-lib.sh"
[[ -r "$claude_source/.credentials.json" ]] || { printf 'UNAVAILABLE real Claude credentials for isolated receiver\n' >&2; exit 2; }
mkdir -p "$TEST_HOME/.claude" "$WORK/project"
cp "$claude_source/.credentials.json" "$TEST_HOME/.claude/.credentials.json"
chmod 600 "$TEST_HOME/.claude/.credentials.json"
export MAILBOX_REAL_ROOT="$WORK" MAILBOX_REAL_SCENARIO="$scenario" MAILBOX_REAL_APP="$APP"
export MAILBOX_REAL_HOME="$TEST_HOME" MAILBOX_REAL_SERVER="$SERVER"
sno_record_programs "reach=$REACH"
# The Python driver observes real agent transcripts; it never reads mail for the agent.
python3 - <<'PY'
import email.utils, json, os, shlex, shutil, socket, subprocess, time, uuid
from pathlib import Path
root=Path(os.environ['MAILBOX_REAL_ROOT']); home=Path(os.environ['MAILBOX_REAL_HOME'])
app=Path(os.environ['MAILBOX_REAL_APP']); server=os.environ['MAILBOX_REAL_SERVER']
scenario=os.environ['MAILBOX_REAL_SCENARIO']; project=root/'project'; state=root/'state'
nonce=uuid.uuid4().hex[:12]; address='worker.mailbox-'+nonce+'@'+socket.gethostname()
real_sno=shutil.which('sno'); real_claude=shutil.which('claude')
assert real_sno and real_claude, 'real sno and claude are required'
env={k:v for k,v in os.environ.items() if k not in ('CLAUDECODE','CODEX_THREAD_ID','SNO_REACH_ADDR','SNO_EXECUTOR_ADDR','TMUX','TMUX_PANE')}
env.update(HOME=str(home), CLAUDE_CONFIG_DIR=str(home/'.claude'), CODEX_HOME=str(home/'.codex'),
           SNO_PROFILE_DIR=str(home/'.sno'), XDG_CONFIG_HOME=str(home/'.config'),
           XDG_STATE_HOME=str(home/'.local/state'), XDG_CACHE_HOME=str(home/'.cache'),
           SNO_REACH_ROOT=str(state), DISABLE_AUTOUPDATER='1', TERM='xterm-256color')
version=subprocess.check_output([real_claude,'--version'],env=env,text=True).strip()
config=dict(hasCompletedOnboarding=True,lastOnboardingVersion=version.split()[0],
            bypassPermissionsModeAccepted=True,projects={str(project):dict(hasTrustDialogAccepted=True)})
(home/'.claude/.claude.json').write_text(json.dumps(config))
(home/'.claude.json').write_text(json.dumps(config))
started=time.monotonic()
print('real receiver host='+socket.gethostname()+' cli='+version+' scenario='+scenario,flush=True)
def mux(*args,check=True):
    return subprocess.run(['tmux','-L',server,*args],env=env,text=True,capture_output=True,check=check,timeout=10)
def reach(*args,limit=85,input=None):
    result=subprocess.run([real_sno,'reach',*args],env=env,cwd=project,input=input,text=True,capture_output=True,timeout=limit)
    with (root/'commands.log').open('a') as f:
        f.write(json.dumps(dict(args=list(args),status=result.returncode,stdout=result.stdout,stderr=result.stderr))+'\n')
    return result
def require(result,status=0):
    assert result.returncode==status, (result.returncode,result.stdout,result.stderr)
    return result

def transcript_text():
    meta=state/address/'transcript.json'
    if not meta.exists(): return ''
    path=Path(json.loads(meta.read_text())['transcript'])
    if not path.exists(): return ''
    texts=[]
    for line in path.read_text().splitlines():
        try: row=json.loads(line)
        except json.JSONDecodeError: continue
        if row.get('type')=='assistant':
            texts += [block.get('text','') for block in row.get('message',{}).get('content',[]) if block.get('type')=='text']
    return '\n'.join(texts)

def wait_until(check,label,seconds=60):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        if check(): return
        time.sleep(.3)
    pane_text=mux('capture-pane','-p','-t',pane,'-S','-').stdout
    (root/'failure-screen.txt').write_text(pane_text)
    raise AssertionError(label+'; see '+str(root/'failure-screen.txt'))

def stored_payload(expected):
    matches=[]
    for directory in ('new','cur'):
        for path in (state/address/directory).iterdir():
            body=path.read_bytes()
            if b'\n\nOriginal call text:\n' in body and body.split(b'\n\nOriginal call text:\n',1)[1]==expected.encode():
                matches.append(path)
    assert len(matches)==1, ('exact saved call text not found',len(matches))
    return matches[0]

try:
    mux('-f','/dev/null','new-session','-d','-x','160','-y','45','-s','fixture','cat')
    env['TMUX']=mux('display-message','-p','#{socket_path},#{pid},0').stdout.strip()
    require(reach('init','--as',address,'--name','Receiver'))
    if scenario=='handoff-acp':
        config_dir=home/'.config/sno-reach'; config_dir.mkdir(parents=True,exist_ok=True)
        (config_dir/'agents.json').write_text('{"claude":{"acpx_agent":"claude"}}\n')
        require(reach('spawn','claude','--as',address,'--cwd',str(project),limit=60))
        pane='%0'
    else:
        require(reach('spawn','claude','--as',address,'--cwd',str(project),'--window',limit=30))
        pane=json.loads((state/address/'reachable.json').read_text())['identity']['value']
        wait_until(lambda: bool(transcript_text()),'receiver startup did not finish')
    # The startup turn reads the installed guide. Wait until the command prompt is idle.
    time.sleep(1)
    if scenario=='handoff-card':
        sender='lead.transfer-'+nonce+'@'+socket.gethostname()
        owner='lead.owner-'+nonce+'@'+socket.gethostname()
        for person in (sender,owner):
            require(reach('init','--as',person,'--name','Owner'))
        actor=app.parent.parent/'tests/apps/reach/fixtures/tmux-ack-actor.sh'
        owner_pane=mux('new-window','-d','-P','-F','#{pane_id}','-t','fixture','bash '+shlex.quote(str(actor))).stdout.strip()
        wait_until(lambda:'READY integration ACK actor' in mux('capture-pane','-p','-t',owner_pane).stdout,'original Reply-To receiver did not start',5)
        require(reach('register','--as',owner,'--channel','tmux','--handle',owner_pane))
        original='<handoff-task-'+nonce+'@'+socket.gethostname()+'>'
        work='handoff-task-'+nonce
        card=(f'From: Transfer <{sender}>\nTo: Receiver <{address}>\nReply-To: Owner <{owner}>\n'
              f'Date: {email.utils.formatdate(localtime=False)}\nSubject: [DECISION] Released scratch work\n'
              f'Message-ID: {original}\nX-Type: decision\nX-Work: {work}\n\n'
              'Accept this original task card but remain paused until an explicit release. '
              'After release write card-result.txt and complete this same card to its original Reply-To.\n')
        require(reach('send','--as',sender,'--no-ring',input=card))
        ready_text=('Read your inbox and find original task card '+original+'. Accept that original card with sno reach reply --state accepted, with a nonblank body. '
                    'Do not accept or complete this call transport mail. Remain paused without file writes, then output HANDOFF_READY '+nonce+'.')
        require(reach('call',address,ready_text,'--expect','HANDOFF_READY '+nonce,'--timeout','60','--every','1'))
        rows=[json.loads(line) for line in require(reach('state','--work',work,'--json')).stdout.splitlines()]
        assert len(rows)==1 and rows[0]['message_id']==original and rows[0]['recipient']==address and rows[0]['state']=='accepted',rows
        assert not (project/'card-result.txt').exists()
        release=('Release original task '+original+' with nonce '+nonce+'. Output HANDOFF_RELEASED '+nonce+
                 ' now, then write card-result.txt containing '+nonce+'. Keep the original card and its Reply-To; do not complete a call mail.')
        require(reach('call',address,release,'--expect','HANDOFF_RELEASED '+nonce,'--timeout','60','--every','1'))
        wait_until(lambda:(project/'card-result.txt').exists(),'receiver did not write original card result',30)
        assert (project/'card-result.txt').read_text().strip()==nonce
        finish=('Complete original task '+original+' using sno reach reply --state completed with a nonblank body on that original card, preserving its original Reply-To. '
                'Do not reply to or complete call transport mail. Then output CARD_COMPLETED '+nonce+'.')
        require(reach('call',address,finish,'--expect','CARD_COMPLETED '+nonce,'--timeout','60','--every','1'))
        rows=[json.loads(line) for line in require(reach('state','--work',work,'--json')).stdout.splitlines()]
        assert len(rows)==1 and rows[0]['state']=='completed',rows
        answer=require(reach('wait','--as',owner,'--reply-to',original,'--from',address,'--timeout','1','--every','1')).stdout.strip()
        held=Path(answer)
        assert held.exists() and held.parent.parent==state/owner,answer
        assert 'X-State: completed' in held.read_text()
        print('PASS real card-backed mailbox release retains original work identity, one owned row and Reply-To completion destination',flush=True)
        print('LIMITATION this verifies the receiver card lifecycle and call transport; the complete installed handoff checkpoint/cancellation workflow remains unproven',flush=True)
    elif scenario in ('handoff','handoff-acp'):
        # These are unchanged call transport contracts, with an explicit release before writing.
        # The installed handoff skill itself remains read-only and is not replaced by this driver.
        readiness='Readiness nonce '+nonce+'. Do not write a file yet. Reply exactly HANDOFF_READY '+nonce+'.'
        ready=require(reach('call',address,readiness,'--expect','HANDOFF_READY '+nonce,'--timeout','60','--every','1'))
        stored_payload(readiness)
        assert not (project/'released.txt').exists()
        release='Release nonce '+nonce+'. Output HANDOFF_RELEASED '+nonce+' now, then write released.txt containing '+nonce+'.'
        released=require(reach('call',address,release,'--expect','HANDOFF_RELEASED '+nonce,'--timeout','60','--every','1'))
        stored_payload(release)
        wait_until(lambda:(project/'released.txt').exists(),'receiver did not act after release',30)
        assert (project/'released.txt').read_text().strip()==nonce
        pause='Pause all scratch-file writes now. Output exactly HANDOFF_PAUSED '+nonce+'.'
        paused=require(reach('call',address,pause,'--expect','HANDOFF_PAUSED '+nonce,'--timeout','60','--every','1'))
        snapshot='The snapshot is unchanged. Output exactly HANDOFF_SNAPSHOT_UNCHANGED '+nonce+'.'
        unchanged=require(reach('call',address,snapshot,'--expect','HANDOFF_SNAPSHOT_UNCHANGED '+nonce,'--timeout','60','--every','1'))
        for value,marker in ((ready,'HANDOFF_READY'),(released,'HANDOFF_RELEASED'),(paused,'HANDOFF_PAUSED'),(unchanged,'HANDOFF_SNAPSHOT_UNCHANGED')):
            assert marker+' '+nonce in value.stdout
        print('PASS real '+scenario+' receiver mailbox readiness/release/pause/snapshot outputs and release-controlled file write',flush=True)
        print('LIMITATION this proves direct no-card call transport; full installed handoff/card-backed lifecycle is not exercised',flush=True)
    else:
        answer='MAILBOX-PICKUP-'+nonce
        text=('Read the complete original call text. Write pickup.txt with exactly '+answer+'. Then output exactly '+answer+'.\n'+
              ('Context line '+nonce+'; retain every character.\n')*120+'END '+nonce+'\n\n')
        if scenario=='typing':
            mux('send-keys','-t',pane,'-l','--','unfinished-person-draft')
            time.sleep(.3)
            result=reach('call',address,text,'--expect',answer,'--timeout','5','--every','1',limit=15)
            require(result,3)
            assert 'stored' in result.stderr
            stored_payload(text)
            assert 'unfinished-person-draft' in mux('capture-pane','-p','-t',pane).stdout
            mux('send-keys','-t',pane,'C-u')
        else:
            require(reach('call',address,'/compact','--raw',limit=10))
            # Start the call immediately after the receiver's own /compact command.
            result=reach('call',address,text,'--expect',answer,'--timeout','60','--every','1')
            assert result.returncode in (0,3,4), (result.returncode,result.stdout,result.stderr)
            stored_payload(text)
        if not (project/'pickup.txt').exists():
            # Explicit next user turn after the interruption; no automatic retry is claimed.
            require(reach('call',address,'Read your inbox and open each exact returned call-mail file. Handle the pending original instruction completely.','--raw',limit=10))
            wait_until(lambda:(project/'pickup.txt').exists(),'real receiver did not recover pending call',60)
        assert (project/'pickup.txt').read_text().strip()==answer
        wait_until(lambda:answer in transcript_text(),'receiver output did not contain content-derived answer',20)
        print('PASS real '+scenario+' receiver independently read retained full call and performed its instruction; original call exit='+str(result.returncode),flush=True)
    transcript=Path(json.loads((state/address/'transcript.json').read_text())['transcript'])
    if scenario=='compacting':
        assert any(json.loads(line).get('subtype')=='compact_boundary' for line in transcript.read_text().splitlines()), 'receiver did not actually compact'
    models=sorted({json.loads(line).get('message',{}).get('model','') for line in transcript.read_text().splitlines() if '"type":"assistant"' in line or '"type": "assistant"' in line}) if transcript.exists() else []
    print('actual model/provider='+(','.join(filter(None,models)) or 'not reported by ACP metadata')+' / anthropic elapsed='+str(round(time.monotonic()-started,1))+'s',flush=True)
finally:
    mux('capture-pane','-p','-t',locals().get('pane','%0'),'-S','-',check=False)
    mux('kill-server',check=False)
    if scenario=='handoff-acp' and (state/address/'reachable.json').exists():
        handle=json.loads((state/address/'reachable.json').read_text())['handle']
        session=handle.rsplit(':',1)[1]
        subprocess.run(['acpx','--cwd',str(project),'--format','json','claude','sessions','close',session],env=env,capture_output=True,text=True,timeout=15)
    # Credential copies never become retained test evidence.
    (home/'.claude/.credentials.json').unlink(missing_ok=True)
    print('real mailbox evidence: '+str(root),flush=True)
PY
