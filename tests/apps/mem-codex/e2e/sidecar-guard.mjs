export function sidecarGuardScript(unit, entry) {
	return `
main=$(systemctl --user show -p MainPID --value ${unit})
node_bin=$(readlink -f "$(command -v node)")
pids=$(pgrep -f -x -- "$node_bin ${entry}" | sort -n | paste -sd, - || true)
printf '{"unit_main_pid":%s,"pids":[%s]}\\n' "${"${main:-0}"}" "$pids"
test "${"${main:-0}"}" -gt 0
test "$pids" = "$main"
`;
}

export function assertSingleSidecar(remote, unit, entry, label) {
	const result = remote(sidecarGuardScript(unit, entry));
	if (result.status !== 0) {
		throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
	}
	const observed = JSON.parse(result.stdout.trim());
	if (observed.pids.length !== 1 || observed.pids[0] !== observed.unit_main_pid) {
		throw new Error(`${label} mismatch: ${JSON.stringify(observed)}`);
	}
	return observed;
}
