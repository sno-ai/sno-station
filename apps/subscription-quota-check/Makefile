SHELL := /bin/bash
.SHELLFLAGS := -Eeuo pipefail -c
.ONESHELL:
PROGRAM := subscription-quota-check
REPO_ROOT := $(abspath ../..)

.PHONY: test package

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
