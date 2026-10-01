import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	binary, profile, quote, remote, remoteRoot, seedConfig, install, success, unit,
} from "./harness.mjs";

export const appState = `${profile}/sno-mem-claude`;

export function observedWorkerConfig(label) {
	const configDir = seedConfig(label);
	install(configDir);
	const binDir = `${configDir}/observer-bin`;
	const observationFile = `${configDir}/child-observations.jsonl`;
	const realClaude = success(remote("command -v claude"), "real Claude executable");
	const source = readFileSync(new URL("./claude-observer.mjs", import.meta.url)).toString("base64");
	success(remote(`mkdir -p ${quote(binDir)}\nprintf '%s' ${quote(source)} | base64 -d > ${quote(`${binDir}/claude`)}\nchmod 700 ${quote(`${binDir}/claude`)}`), "install child observer");
	return { configDir, observationFile, binDir, realClaude,
		environment: `PATH=${quote(binDir)}:"$PATH" SNO_REAL_CLAUDE=${quote(realClaude)} SNO_CLAUDE_OBSERVATION_FILE=${quote(observationFile)} CLAUDE_CONFIG_DIR=${quote(configDir)} SNO_PROFILE_DIR=${profile}` };
}

export function childObservations(observed) {
	return JSON.parse(success(remote(`python3 - <<'PY'
import json
from pathlib import Path
p = Path(${JSON.stringify(observed.observationFile)})
print(json.dumps([json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []))
PY`), "read child observations"));
}

export function enqueueTurn(project, user, assistant, label) {
	const turnId = `${label}-${randomUUID()}`;
	const record = { sessionId: randomUUID(), turnId, project, childCwd: project,
		user, assistant, at: Date.now(), attempts: 0, state: "pending" };
	const path = `${appState}/spool/${String(record.at).padStart(16, "0")}-${randomUUID()}.json`;
	success(remote(`mkdir -p ${appState}/spool\nprintf '%s' ${quote(JSON.stringify(record))} > ${quote(path)}`), "enqueue worker fixture");
	return { turnId, path, record };
}

export function workerRun(observed, extraEnvironment = "") {
	const result = remote(`env -u CLAUDECODE ${observed.environment} ${extraEnvironment} ${binary} worker`, 600_000);
	const output = success(result, "worker drain");
	return { stdout: output, stderr: result.stderr };
}

export function waitForTurn(turnId) {
	return JSON.parse(success(remote(`python3 - <<'PY'
import json, time
from pathlib import Path
root = Path('${appState}')
end = time.monotonic() + 590
while time.monotonic() < end:
    records = [json.loads(p.read_text()) for p in (root/'spool').glob('*.json')]
    matching = [r for r in records if r.get('turnId') == '${turnId}']
    log = (root/'worker.log').read_text() if (root/'worker.log').exists() else ''
    committed = any(json.loads(line).get('turnId') == '${turnId}' and json.loads(line).get('committed') is True
                    for line in log.splitlines() if line.startswith('{') and 'capture-committed' in line)
    if committed or (matching and matching[0].get('state') == 'failed'):
        print(json.dumps({'committed': committed, 'records': matching, 'spool_count': len(records)}))
        break
    time.sleep(1)
else:
    raise SystemExit('turn did not commit or fail within 590 seconds')
PY`, 600_000), "await worker turn"));
}

export function nativeMode() {
	const path = `${profile}/settings.json`;
	const currentMode = success(remote(`jq -er .mode ${path}`), "read settings mode");
	if (currentMode === "agent-native") return () => {};
	const backup = `${remoteRoot}/tmp/native-settings-${randomUUID()}.json`;
	success(remote(`cp -p ${path} ${backup}\npython3 - <<'PY'
import json
from pathlib import Path
p=Path('${path}')
s=json.loads(p.read_text())
s['mode']='agent-native'
p.write_text(json.dumps(s, indent=2) + "\\n")
PY
${restartSidecar}`), "set native test mode");
	return () => success(remote(`cp -p ${backup} ${path}\nrm ${backup}\n${restartSidecar}`), "restore settings mode");
}

// The sidecar reads settings.json when it starts; a mode change (as sno makes it) takes effect on restart.
const restartSidecar = `systemctl --user restart ${unit}
for _ in $(seq 1 100); do
  port=$(jq -r .port ${profile}/station/sidecar.json 2>/dev/null) && curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && exit 0
  sleep 0.2
done
exit 1`;
