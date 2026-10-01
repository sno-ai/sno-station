#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
# The accepted archive home is never passed to make install. A second empty home
# proves the source Makefile's installer independently against the same bytes.
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd -- "$HERE/../../../apps/reach" && pwd)"
direct=no
if [[ "${1:-}" == --direct ]]; then direct=yes; shift; fi
archive="$(realpath -- "${1:?provide frozen reach-VERSION-OS-ARCH.tar.gz}")"
proof="${2:?provide a new evidence directory}"
[[ ! -e "$proof" ]] || { printf 'evidence directory must not exist\n' >&2; exit 2; }
mkdir -p "$proof"
proof="$(realpath "$proof")"
version="$(<"$APP/VERSION")"
dispatcher=''
if [[ "$direct" == no ]]; then dispatcher="$(command -v sno)"; fi
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
archive_home="$proof/archive-home"
source_home="$proof/source-home"
release="$archive_home/.local/lib/sno-reach/releases/$version"
mkdir -p "$release" "$archive_home/.local/bin" "$source_home"
tar -xzf "$archive" -C "$release"
[[ "$(<"$release/VERSION")" == "$version" ]]
ln -s "$release" "$archive_home/.local/lib/sno-reach/current"
ln -s "$archive_home/.local/lib/sno-reach/current/bin/sno-reach" "$archive_home/.local/bin/sno-reach"
manifest() {
  (cd "$1" && find . -printf '%P %y %m %l\n' | sort &&
    find . -type f -print0 | sort -z | xargs -0 sha256sum)
}
manifest "$release" >"$proof/archive-before"
# Makefile runs in a scratch app containing only install inputs; it cannot build
# or overlay the archive-home candidate from a source checkout.
mkdir -p "$proof/source-input/dist"
cp "$APP/Makefile" "$APP/VERSION" "$proof/source-input/"
cp "$archive" "$archive.sha256" "$proof/source-input/dist/"
HOME="$source_home" make -C "$proof/source-input" install >"$proof/install.log" 2>&1
diff -qr "$release" "$source_home/.local/lib/sno-reach/releases/$version"
tmux -L "$server" -f /dev/null new-session -d -s fixture cat
tmux_environment="$(tmux -L "$server" display-message -p '#{socket_path},#{pid},0')"
pane="$(tmux -L "$server" display-message -p '#{pane_id}')"
for install_home in "$archive_home" "$source_home"; do
  actual="$(env HOME="$install_home" PATH="$install_home/.local/bin:$PATH" sh -c 'command -v sno-reach')"
  [[ "$(readlink -f "$actual")" == "$install_home/.local/lib/sno-reach/releases/$version/bin/sno-reach" ]]
  [[ "$(env HOME="$install_home" "$actual" --version)" == "$version" ]]
  installed() {
    local -a entry=("$dispatcher" reach)
    if [[ "$direct" == yes ]]; then entry=("$actual"); fi
    env HOME="$install_home" PATH="$install_home/.local/bin:$PATH" \
      SNO_REACH_ROOT="$install_home/state" TMUX="$tmux_environment" TMUX_PANE="$pane" \
      "${entry[@]}" "$@"
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
done
# Exercise missing VERSION only in the independent source-install home.
cp -a "$source_home/.local/lib/sno-reach/releases/$version" "$proof/missing-version"
mv "$proof/missing-version/VERSION" "$proof/saved-VERSION"
ln -sfnT "$proof/missing-version" "$source_home/.local/lib/sno-reach/current"
version_entry=("$dispatcher" reach)
if [[ "$direct" == yes ]]; then version_entry=("$source_home/.local/bin/sno-reach"); fi
if env HOME="$source_home" PATH="$source_home/.local/bin:$PATH" "${version_entry[@]}" --version >"$proof/missing-version.out" 2>"$proof/missing-version.err"; then
  printf 'missing VERSION reported success\n' >&2; exit 1
fi
ln -sfnT "$source_home/.local/lib/sno-reach/releases/$version" "$source_home/.local/lib/sno-reach/current"
# Corruption must be rejected before either release or command is installed.
cp "$proof/source-input/dist/${archive##*/}" "$proof/original.tar.gz"
chmod u+w "$proof/source-input/dist/${archive##*/}"
printf 'corrupt\n' >>"$proof/source-input/dist/${archive##*/}"
mkdir -p "$proof/corrupt-home"
if HOME="$proof/corrupt-home" make -C "$proof/source-input" install >"$proof/corruption.log" 2>&1; then
  printf 'corrupt archive installed\n' >&2; exit 1
fi
[[ ! -e "$proof/corrupt-home/.local/lib/sno-reach" ]]
manifest "$release" >"$proof/archive-after"
cmp "$proof/archive-before" "$proof/archive-after"
printf '%s\n' "$archive_home/.local/bin/sno-reach" >"$proof/candidate-command"
printf 'PASS archive roots, checksum refusal, two independent install homes, unchanged candidate payload\n'
