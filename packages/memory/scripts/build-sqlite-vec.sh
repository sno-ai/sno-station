#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
SOURCE_URL="https://github.com/asg017/sqlite-vec/archive/refs/tags/v0.1.9.tar.gz"
SOURCE_SHA256="9823e737d9934dcbe85dff75d3fca81018a9beee803d70fa77b16faab5d61dc9"
OUTPUT="$PLUGIN_ROOT/sqlite-extensions/linux-x64/vec0.so"
EXPORT_MAP="$SCRIPT_DIR/vec0.map"
SQLITE_INCLUDE="$REPO_ROOT/node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3"

usage() {
	printf 'Usage: %s [--build|--check]\n' "${0##*/}"
}

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		printf 'sqlite-vec build requires command: %s\n' "$1" >&2
		exit 2
	fi
}

check_binary() {
	if [[ ! -f "$OUTPUT" ]]; then
		printf 'sqlite-vec artifact missing: %s\n' "$OUTPUT" >&2
		exit 3
	fi
	local exports
	exports="$(nm -D --defined-only "$OUTPUT" | awk '{ print $3 }')"
	if [[ "$exports" != "sqlite3_vec_init" ]]; then
		printf 'sqlite-vec artifact must export only sqlite3_vec_init; got:\n%s\n' "$exports" >&2
		exit 4
	fi
	if nm -D "$OUTPUT" | awk '{ print $3 }' | grep -Fxq sqlite3_api; then
		printf 'sqlite-vec artifact exposes sqlite3_api: %s\n' "$OUTPUT" >&2
		exit 5
	fi
	printf 'sqlite-vec exports verified: %s\n' "$OUTPUT"
}

build_binary() {
	for command in curl gcc make nm sha256sum tar; do
		require_command "$command"
	done
	if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
		printf 'sqlite-vec build supports only Linux-x86_64\n' >&2
		exit 2
	fi
	if [[ ! -f "$SQLITE_INCLUDE/sqlite3ext.h" ]]; then
		printf 'SQLite extension headers missing: %s\n' "$SQLITE_INCLUDE" >&2
		exit 2
	fi

	local temporary_root archive source_dir staged_output
	temporary_root="$(mktemp -d)"
	trap 'rm -rf -- "$temporary_root"' RETURN
	archive="$temporary_root/sqlite-vec-v0.1.9.tar.gz"
	source_dir="$temporary_root/sqlite-vec-0.1.9"
	staged_output="$temporary_root/vec0.so"

	curl -fsSL --retry 3 --proto '=https' --tlsv1.2 "$SOURCE_URL" -o "$archive"
	printf '%s  %s\n' "$SOURCE_SHA256" "$archive" | sha256sum --check --status
	tar -xzf "$archive" -C "$temporary_root"
	make -C "$source_dir" sqlite-vec.h
	gcc -O2 -fPIC -shared -Wl,"--version-script=$EXPORT_MAP" \
		-DSQLITE_VEC_ENABLE_AVX -mavx \
		-I "$source_dir" -I "$SQLITE_INCLUDE" \
		-o "$staged_output" "$source_dir/sqlite-vec.c" -lm

	mkdir -p -- "$(dirname "$OUTPUT")"
	install -m 0755 "$staged_output" "$OUTPUT.next"
	mv -f -- "$OUTPUT.next" "$OUTPUT"
	check_binary
}

case "${1:---build}" in
	--build)
		build_binary
		;;
	--check)
		require_command nm
		check_binary
		;;
	-h|--help)
		usage
		;;
	*)
		usage >&2
		exit 2
		;;
esac
