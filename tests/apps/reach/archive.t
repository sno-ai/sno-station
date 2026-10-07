#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
# The accepted archive is unpacked and run by path; nothing here installs it.
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/reach" && pwd)"
archive="$(realpath -- "${1:?provide frozen reach-VERSION-OS-ARCH.tar.gz}")"
proof="${2:?provide a new evidence directory}"
[[ ! -e "$proof" ]] || { printf 'evidence directory must not exist\n' >&2; exit 2; }
mkdir -p "$proof"
proof="$(realpath "$proof")"
version="$(<"$APP/VERSION")"
server="reach-package-$$"
trap 'tmux -L "$server" kill-server 2>/dev/null || true' EXIT
case "$(uname -s)" in Linux) platform_os=linux;; Darwin) platform_os=macos;; *) exit 2;; esac
case "$(uname -m)" in x86_64) platform_arch=x86_64;; aarch64|arm64) platform_arch=aarch64;; *) exit 2;; esac
[[ "${archive##*/}" == "reach-$version-$platform_os-$platform_arch.tar.gz" ]]
printf 'host=%s\narchive=%s\n' "$(hostname)" "$archive" >"$proof/provenance"
sha256sum "$archive" >>"$proof/provenance"
(cd "$(dirname "$archive")" && sha256sum -c "${archive##*/}.sha256")
tar -tzf "$archive" >"$proof/members"
grep -qx 'lib/reach-machine-id' "$proof/members"
[[ "$(wc -l <"$proof/members")" -eq 48 ]]
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$proof/members"; then
  printf 'unsafe archive member\n' >&2; exit 1
fi
cut -d/ -f1 "$proof/members" | sort -u >"$proof/roots"
printf '%s\n' LICENSE NOTICE VERSION bin guide lib spec vendor >"$proof/expected-roots"
cmp "$proof/expected-roots" "$proof/roots"
release="$proof/release"
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
[[ "$(<"$release/VERSION")" == "$version" ]]
manifest() {
  (cd "$1" && find . -printf '%P %y %m %l\n' | sort &&
    find . -type f -print0 | sort -z | xargs -0 sha256sum)
}
manifest "$release" >"$proof/archive-before"
tmux -L "$server" -f /dev/null new-session -d -s fixture cat
tmux_environment="$(tmux -L "$server" display-message -p '#{socket_path},#{pid},0')"
pane="$(tmux -L "$server" display-message -p '#{pane_id}')"
install_home="$proof/home"
mkdir -p "$install_home"
actual="$release/bin/sno-reach"
[[ "$(env HOME="$install_home" "$actual" --version)" == "$version" ]]
installed() {
  env HOME="$install_home" SNO_REACH_ROOT="$install_home/state" TMUX="$tmux_environment" TMUX_PANE="$pane" \
    "$actual" "$@"
}
[[ "$(installed --version)" == "$version" ]]
installed --help >"$install_home/help"
for verb in spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind; do
  grep -qw "$verb" "$install_home/help"
done
printf '%s\n' spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind | sort >"$install_home/expected-verbs"
tail -n +2 "$install_home/help" | tr '[:space:]' '\n' | sed '/^$/d' | sort >"$install_home/actual-verbs"
cmp "$install_home/expected-verbs" "$install_home/actual-verbs"
for args in '' frobnicate; do
  rc=0
  if [[ -n "$args" ]]; then installed "$args" >"$install_home/usage" 2>&1 || rc=$?
  else installed >"$install_home/usage" 2>&1 || rc=$?; fi
  [[ "$rc" == 64 ]]
  cmp "$install_home/help" "$install_home/usage"
done
address="lead.package@$(hostname)"
installed init --as "$address" --name Package >"$install_home/init"
installed register --as "$address" --channel tmux --handle "$pane" >"$install_home/register"
installed doctor --as "$address" >"$install_home/doctor"
grep -qx DOCTOR-OK "$install_home/doctor"
# A release without VERSION must fail.
cp -a "$release" "$proof/missing-version"
rm "$proof/missing-version/VERSION"
if env HOME="$install_home" "$proof/missing-version/bin/sno-reach" --version >"$proof/missing-version.out" 2>"$proof/missing-version.err"; then
  printf 'missing VERSION reported success\n' >&2; exit 1
fi
manifest "$release" >"$proof/archive-after"
cmp "$proof/archive-before" "$proof/archive-after"
printf 'PASS archive roots, checksum, unpacked payload runs and is unchanged\n'
