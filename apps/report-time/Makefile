SHELL := /bin/bash
.SHELLFLAGS := -Eeuo pipefail -c
.ONESHELL:
PROGRAM := report-time
REPO_ROOT := $(abspath ../..)

.PHONY: test package install

test:
	bash "$(REPO_ROOT)/tests/apps/$(PROGRAM)/run.sh"

package:
	@contract="$(CONTRACT)"
	if [[ -z "$$contract" || ! -f "$$contract" || ! -r "$$contract" ]]; then
		printf '%s\n' 'package: missing readable CONTRACT: sno-station-skills/scripts/requirements-contract.json' >&2
		exit 2
	fi
	jq -se 'length == 1 and (.[0] | type == "object")' "$$contract" >/dev/null || { printf '%s\n' 'package: contract must be one JSON object' >&2; exit 2; }
	jq --stream -se '[.[] | select(length == 2) | .[0] | select(length == 1 or (length == 2 and .[1] == 0)) | .[0]] | group_by(.) | all(length == 1)' "$$contract" >/dev/null || { printf '%s\n' 'package: duplicate contract key' >&2; exit 2; }
	for rule in \
		'keys|. == ["need_values","program_ids","schema_version","slot_ids","version_pattern"]' \
		'.schema_version == 1' \
		'(.program_ids|sort) == ["heartbeat","reach","report-time","subscription-quota-check"]' \
		'(.need_values|sort) == ["optional","preferred","required"]' \
		'(.slot_ids|sort) == ["2.pre-turn-context-injection","3.reader-to-agent-delivery","4.background-processes","4.file-read-write","4.shell"]' \
		'.version_pattern == "^[0-9]+[.][0-9]+([.][0-9]+)?$$"'; do
		jq -e "$$rule" "$$contract" >/dev/null || { printf 'package: invalid contract field: %s\n' "$$rule" >&2; exit 2; }
	done
	version="$$(<VERSION)"
	[[ "$$version" =~ ^[0-9]+[.][0-9]+([.][0-9]+)?$$ ]] || { printf '%s\n' 'package: invalid VERSION' >&2; exit 2; }
	epoch="$$(git -C "$(REPO_ROOT)" show -s --format=%ct HEAD)"
	[[ "$$epoch" =~ ^[0-9]+$$ ]] || { printf '%s\n' 'package: source commit time unavailable' >&2; exit 2; }
	stage="$$(mktemp -d)"
	trap 'rm -r -- "$$stage"' EXIT
	mkdir -- "$$stage/bin"
	cp -p -- "bin/$(PROGRAM)" "$$stage/bin/$(PROGRAM)"
	cp -p -- VERSION NOTICE "$(REPO_ROOT)/LICENSE" "$$stage/"
	cp -p -- "$$contract" "$$stage/requirements-contract.json"
	digest="$$(sha256sum "$$stage/requirements-contract.json" | cut -d ' ' -f1)"
	jq --arg version "$$version" --arg digest "$$digest" \
		'.version=$$version | .requirements_contract_sha256=$$digest' \
		release.json.in > "$$stage/release.json"
	chmod --reference=release.json.in "$$stage/release.json"
	archive="$(PROGRAM)-$$version.tar.gz"
	mkdir -p -- dist
	temporary="$$(mktemp "dist/.package.XXXXXX")"
	trap 'rm -r -- "$$stage"; rm -f -- "$$temporary"' EXIT
	printf '%s\n' LICENSE NOTICE VERSION "bin/$(PROGRAM)" release.json requirements-contract.json \
		| LC_ALL=C sort \
		| tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$$epoch" -C "$$stage" -cf - -T - \
		| gzip -n > "$$temporary"
	mv -- "$$temporary" "dist/$$archive"
	(cd dist && sha256sum "$$archive") > "dist/$$archive.sha256"
	printf 'packaged %s\n' "dist/$$archive"

install:
	@version="$$(<VERSION)"
	[[ "$$version" =~ ^[0-9]+[.][0-9]+([.][0-9]+)?$$ ]] || { printf '%s\n' 'install: invalid VERSION' >&2; exit 2; }
	archive="$(PROGRAM)-$$version.tar.gz"
	[[ -f "dist/$$archive" && -f "dist/$$archive.sha256" ]] || { printf 'install: missing dist/%s; run make package CONTRACT=<file>\n' "$$archive" >&2; exit 2; }
	(cd dist && sha256sum -c "$$archive.sha256")
	root="$(HOME)/.local/lib/sno-$(PROGRAM)"
	destination="$$root/releases/$$version"
	command_path="$(HOME)/.local/bin/$(PROGRAM)"
	[[ ! -e "$$command_path" || -L "$$command_path" ]] || { printf 'install: existing non-link command must be preserved before install: %s\n' "$$command_path" >&2; exit 2; }
	mkdir -p -- "$$root/releases" "$(HOME)/.local/bin"
	stage="$$(mktemp -d "$$root/releases/.install.XXXXXX")"
	trap 'rm -r -- "$$stage"' EXIT
	tar -xzf "dist/$$archive" -C "$$stage"
	[[ "$$(<"$$stage/VERSION")" == "$$version" && -x "$$stage/bin/$(PROGRAM)" ]] || { printf '%s\n' 'install: archive VERSION or executable is invalid' >&2; exit 2; }
	if [[ -e "$$destination" || -L "$$destination" ]]; then
		if [[ ! -d "$$destination" || -L "$$destination" ]] || ! diff -qr "$$stage" "$$destination" >/dev/null; then
			printf 'install: existing release differs: %s\n' "$$destination" >&2
			exit 2
		fi
	else
		if mv -T -- "$$stage" "$$destination" 2>/dev/null; then
			trap - EXIT
		elif [[ -d "$$destination" && ! -L "$$destination" ]] && diff -qr "$$stage" "$$destination" >/dev/null; then
			: # A concurrent installer published the identical release.
		else
			printf 'install: could not publish release: %s\n' "$$destination" >&2
			exit 2
		fi
	fi
	if [[ ! -L "$$root/current" || "$$(readlink "$$root/current")" != "$$destination" ]]; then
		ln -sfnT -- "$$destination" "$$root/current"
	fi
	if [[ ! -L "$$command_path" || "$$(readlink "$$command_path")" != "$$root/current/bin/$(PROGRAM)" ]]; then
		ln -sfnT -- "$$root/current/bin/$(PROGRAM)" "$$command_path"
	fi
	printf 'installed %s %s\n' "$(PROGRAM)" "$$version"
