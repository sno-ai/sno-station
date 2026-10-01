#!/usr/bin/env bash
# Focused acceptance probes. Mutations and installs stay in disposable directories.
set -Eeuo pipefail
export LC_ALL=C
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/utility-release-proof.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
APPS=(heartbeat report-time subscription-quota-check)
FIXTURE="$HERE/fixtures/requirements-contract.json"
CONTRACT_FILE="${UTILITY_TEST_CONTRACT:-$FIXTURE}"
BASELINE=8b4b3a36cfbfd40b25ff47994ce55dfec03fc695

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }
snapshot() {
  mkdir -p "$WORK/repo/apps" "$WORK/repo/tests/apps"
  cp "$ROOT/LICENSE" "$WORK/repo/LICENSE"
  for app in "${APPS[@]}"; do
    cp -a "$ROOT/apps/$app" "$WORK/repo/apps/$app"
    rm -rf -- "$WORK/repo/apps/$app/dist"
    cp -a "$ROOT/tests/apps/$app" "$WORK/repo/tests/apps/$app"
  done
  git -C "$WORK/repo" init -q
  git -C "$WORK/repo" add .
  epoch="$(git -C "$ROOT" log -1 --format=%ct)"
  GIT_AUTHOR_DATE="@$epoch +0000" GIT_COMMITTER_DATE="@$epoch +0000" \
    git -C "$WORK/repo" -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
}
version_of() { printf '%s' "$(<"$ROOT/apps/$1/VERSION")"; }
build() { make -C "$WORK/repo/apps/$1" package "CONTRACT=$CONTRACT_FILE"; }
refused() {
  local expected="$1"; shift
  if "$@" >"$WORK/refusal.log" 2>&1; then fail "accepted invalid input: $expected"; fi
  grep -F "$expected" "$WORK/refusal.log" || fail "refusal did not name $expected"
}
no_archive() {
  [[ ! -d "$WORK/repo/apps/$1/dist" ]] ||
    [[ -z "$(find "$WORK/repo/apps/$1/dist" -type f -print -quit)" ]] ||
    fail "$1 created output after refusal"
}
unpack() {
  local app="$1"
  mkdir -p "$WORK/unpacked/$app"
  tar xzf "$WORK/repo/apps/$app/dist/$app-$(version_of "$app").tar.gz" -C "$WORK/unpacked/$app"
}

case "${1:-}" in
reproducible)
  snapshot
  good_commit="$(git -C "$WORK/repo" rev-parse HEAD)"
  for app in "${APPS[@]}"; do
    # Literal Make recipe variables are the mutation target.
    # shellcheck disable=SC2016
    grep -F -- '--mtime="@$$epoch"' "$WORK/repo/apps/$app/Makefile" >/dev/null || fail 'mtime control not found'
    # shellcheck disable=SC2016
    sed -i 's/ --mtime="@\$\$epoch"//' "$WORK/repo/apps/$app/Makefile"
  done
  git -C "$WORK/repo" add apps
  git -C "$WORK/repo" -c user.name=Test -c user.email=test@example.invalid commit -qm 'remove timestamp normalization'
  bad_commit="$(git -C "$WORK/repo" rev-parse HEAD)"
  for wave in first second; do
    for state in good bad; do
      clone="$WORK/$wave-$state"
      git clone -q --no-local --no-checkout "$WORK/repo" "$clone"
      commit="$good_commit"
      [[ "$state" == good ]] || commit="$bad_commit"
      git -C "$clone" checkout -q --detach "$commit"
      [[ -z "$(git -C "$clone" status --porcelain)" ]] || fail 'checkout is not clean'
      printf 'checkout=%s commit=%s time=%s\n' "$clone" "$commit" "$(date -u +%s)"
      for app in "${APPS[@]}"; do
        make -C "$clone/apps/$app" package "CONTRACT=$CONTRACT_FILE"
      done
    done
    if [[ "$wave" == first ]]; then
      printf 'Waiting 61 seconds so checkout file timestamps differ.\n'
      sleep 61
    fi
  done
  for app in "${APPS[@]}"; do
    relative="apps/$app/dist/$app-$(version_of "$app").tar.gz"
    cmp "$WORK/first-good/$relative" "$WORK/second-good/$relative"
    cmp "$WORK/first-good/$relative.sha256" "$WORK/second-good/$relative.sha256"
    if cmp -s "$WORK/first-bad/$relative" "$WORK/second-bad/$relative"; then
      fail "$app missing --mtime did not change archive bytes"
    fi
    sha256sum "$WORK/first-good/$relative" "$WORK/second-good/$relative" "$WORK/first-bad/$relative" "$WORK/second-bad/$relative"
    pass "$app two clean checkouts reproducible; removing --mtime breaks equality"
  done
  ;;
identity)
  workshop="${2:?usage: release-proof.sh identity WORKSHOP_REPO}"
  for app in heartbeat subscription-quota-check; do
    git -C "$workshop" show "$BASELINE:skills/$app/skill/scripts/$app" >"$WORK/$app"
    # Both current moves retain even the original header; no ignored differences.
    cmp "$WORK/$app" "$ROOT/apps/$app/bin/$app"
    bash "$WORK/$app" --help >"$WORK/original.help"
    "$ROOT/apps/$app/bin/$app" --help >"$WORK/moved.help"
    cmp "$WORK/original.help" "$WORK/moved.help"
    pass "$app baseline bytes and help unchanged"
  done
  mkdir "$WORK/tools"
  for tool in bash jq timeout date mkfifo mktemp rm uname; do
    ln -s "$(command -v "$tool")" "$WORK/tools/$tool"
  done
  rc=0
  env PATH="$WORK/tools" "$ROOT/apps/subscription-quota-check/bin/subscription-quota-check" \
    --vendor codex --json >"$WORK/missing.json" || rc=$?
  [[ "$rc" == 3 ]] || fail "missing codex returned $rc"
  jq -e '.vendors[0].verdict == "unknown"' "$WORK/missing.json" >/dev/null
  rm "$WORK/tools/mkfifo"
  rc=0
  env PATH="$WORK/tools" "$ROOT/apps/subscription-quota-check/bin/subscription-quota-check" \
    --vendor codex --json >"$WORK/missing-tool.log" 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || fail "missing mkfifo returned $rc"
  grep -F mkfifo "$WORK/missing-tool.log"
  pass 'missing codex exits 3; missing mkfifo exits 2 and names it'
  ;;
duplicate-contract)
  # Targeted entry to the same assertion also included in refusal, not extra coverage.
  snapshot
  sed 's/"schema_version": 1,/"schema_version": 2, "schema_version": 1,/' "$CONTRACT_FILE" >"$WORK/duplicate-contract.json"
  for app in "${APPS[@]}"; do
    refused duplicate make -C "$WORK/repo/apps/$app" package "CONTRACT=$WORK/duplicate-contract.json"
    no_archive "$app"
    pass "$app rejects duplicate contract keys"
  done
  ;;
binding)
  snapshot
  printf '\n# /home/someone/x\n' >>"$WORK/repo/apps/heartbeat/bin/heartbeat"
  refused 'bin/heartbeat' bash "$WORK/repo/tests/apps/heartbeat/run.sh"
  grep -F '/home/someone/x' "$WORK/refusal.log"
  pass 'personal binding stops runner before behavioural tests'
  ;;
package|manifest|install|refusal)
  snapshot
  for app in "${APPS[@]}"; do
    appdir="$WORK/repo/apps/$app"
    if [[ "$1" == refusal ]]; then
      refused 'scripts/requirements-contract.json' env -u CONTRACT make -C "$appdir" package
      grep -F sno-station-skills "$WORK/refusal.log"
      no_archive "$app"
      refused 'scripts/requirements-contract.json' make -C "$appdir" package "CONTRACT=$WORK/absent.json"
      no_archive "$app"
      jq '.schema_version = 2' "$CONTRACT_FILE" >"$WORK/bad-contract.json"
      refused schema_version make -C "$appdir" package "CONTRACT=$WORK/bad-contract.json"
      no_archive "$app"
      jq '.slot_ids = ["4.fake"]' "$CONTRACT_FILE" >"$WORK/bad-contract.json"
      refused slot_ids make -C "$appdir" package "CONTRACT=$WORK/bad-contract.json"
      no_archive "$app"
      sed 's/"schema_version": 1,/"schema_version": 2, "schema_version": 1,/' "$CONTRACT_FILE" >"$WORK/duplicate-contract.json"
      refused duplicate make -C "$appdir" package "CONTRACT=$WORK/duplicate-contract.json"
      no_archive "$app"
      pass "$app refuses missing and malformed contract without output"
      continue
    fi
    if [[ "$1" == install ]]; then
      refused "dist/$app-$(version_of "$app").tar.gz" make -C "$appdir" install "HOME=$WORK/install-home"
    fi
    build "$app"
    unpack "$app"
    release="$WORK/unpacked/$app"
    if [[ "$1" == package ]]; then
      diff -u <(printf '%s\n' LICENSE NOTICE VERSION "bin/$app" release.json requirements-contract.json | sort) \
        <(tar tzf "$appdir/dist/$app-$(version_of "$app").tar.gz" | sed 's@^\./@@' | sort)
      cmp "$ROOT/apps/$app/bin/$app" "$release/bin/$app"
      cmp "$ROOT/LICENSE" "$release/LICENSE"
      cmp "$CONTRACT_FILE" "$release/requirements-contract.json"
      (cd "$appdir/dist" && sha256sum -c "$app-$(version_of "$app").tar.gz.sha256")
      cmp <(cd "$appdir/dist" && sha256sum "$app-$(version_of "$app").tar.gz") "$appdir/dist/$app-$(version_of "$app").tar.gz.sha256"
      pass "$app exact archive files, bytes and checksum"
    elif [[ "$1" == manifest ]]; then
      digest="$(sha256sum "$release/requirements-contract.json" | cut -d ' ' -f1)"
      dependencies='["bash","timeout","flock","tail"]'
      if [[ "$app" == report-time ]]; then
        dependencies='["bash","date","sed","cat","awk","ps","tr","getconf"]'
      elif [[ "$app" == subscription-quota-check ]]; then
        dependencies='["bash","jq","timeout","date","mkfifo","codex","claude","heartbeat"]'
      fi
      jq -e --arg app "$app" --arg version "$(<"$release/VERSION")" --arg hash "$digest" \
        --argjson dependencies "$dependencies" '
        (keys == ["dependencies","program","requirements_contract_sha256","version"]) and
        .program == $app and .version == $version and
        (.version | test("^[0-9]+[.][0-9]+([.][0-9]+)?$")) and
        .requirements_contract_sha256 == $hash and .dependencies == $dependencies' "$release/release.json"
      before="$(sha256sum "$appdir/dist/$app-$(version_of "$app").tar.gz")"
      printf 'v1\n' >"$appdir/VERSION"
      refused VERSION make -C "$appdir" package "CONTRACT=$CONTRACT_FILE"
      [[ "$before" == "$(sha256sum "$appdir/dist/$app-$(version_of "$app").tar.gz")" ]] || fail 'invalid VERSION changed archive'
      [[ ! -e "$appdir/dist/$app-v1.tar.gz" ]] || fail 'invalid VERSION produced archive'
      pass "$app manifest and invalid VERSION refusal"
    else
      make -C "$appdir" install "HOME=$WORK/install-home"
      installed="$WORK/install-home/.local/lib/sno-$app/releases/$(version_of "$app")"
      current="$WORK/install-home/.local/lib/sno-$app/current"
      command_path="$WORK/install-home/.local/bin/$app"
      [[ -L "$current" && -L "$command_path" ]] || fail 'install did not create links'
      [[ "$(readlink -f "$current")" == "$installed" ]] || fail 'current points elsewhere'
      [[ "$(readlink -f "$command_path")" == "$installed/bin/$app" ]] || fail 'command points elsewhere'
      [[ "$(readlink "$command_path")" == *"current/bin/$app" ]] || fail 'command bypasses current'
      diff -r "$release" "$installed"
      "$command_path" --help >"$WORK/installed.help"
      "$ROOT/apps/$app/bin/$app" --help >"$WORK/source.help"
      cmp "$WORK/installed.help" "$WORK/source.help"
      find "$installed" -printf '%P %T@\n' | sort >"$WORK/before.times"
      current_before="$(readlink "$current")"
      sleep 1
      make -C "$appdir" install "HOME=$WORK/install-home"
      cmp "$WORK/before.times" <(find "$installed" -printf '%P %T@\n' | sort)
      diff -r "$release" "$installed"
      [[ "$current_before" == "$(readlink "$current")" ]] || fail 'second install changed current'
      pass "$app install paths, executable help, bytes and unchanged second install"
    fi
  done
  ;;
*) fail 'usage: release-proof.sh identity WORKSHOP_REPO | binding | package | refusal | manifest | install | reproducible' ;;
esac
