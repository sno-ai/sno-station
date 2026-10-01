export function sidecarGuardScript(unit, entry) {
	return `python3 - <<'PY'
import json, os, subprocess
main = int(subprocess.check_output(['systemctl', '--user', 'show', '-p', 'MainPID', '--value', '${unit}'], text=True).strip())
pids = []
for line in subprocess.check_output(['ps', '-eo', 'pid=,args='], text=True).splitlines():
    parts = line.strip().split(None, 2)
    if len(parts) == 3 and os.path.basename(parts[1]) == 'node' and parts[2] == '${entry}':
        pids.append(int(parts[0]))
print(json.dumps({'unit_main_pid': main, 'pids': sorted(pids)}))
raise SystemExit(0 if main > 0 and pids == [main] else 1)
PY`;
}

export function assertSingleSidecar(remote, unit, entry, label) {
	const result = remote(sidecarGuardScript(unit, entry));
	if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout}`);
	const observed = JSON.parse(result.stdout.trim());
	if (observed.pids.length !== 1 || observed.pids[0] !== observed.unit_main_pid) {
		throw new Error(`${label}: ${JSON.stringify(observed)}`);
	}
	return observed;
}
