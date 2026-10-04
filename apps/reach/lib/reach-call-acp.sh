#!/usr/bin/env bash
# Sourced by message-agent-window.sh after argument checks and record routing.
# shellcheck disable=SC2154

if [[ "$follow" == true && "$have_text" == true ]]; then
    printf '%s\n' 'ACP --follow is read-only; --text is not allowed' >&2
    exit "$EXIT_USAGE"
fi
handle="$(jq -r '.handle // empty' "$record")"
if [[ ! "$handle" =~ ^acp-([a-zA-Z0-9][a-zA-Z0-9_-]*):(/[^:[:cntrl:]]*):([^:[:space:]]+)$ ]]; then
    printf 'malformed ACP handle: %s\n' "$handle" >&2; exit "$EXIT_UNRELIABLE"
fi
agent="${BASH_REMATCH[1]}" cwd="${BASH_REMATCH[2]}" name="${BASH_REMATCH[3]}"
jq -e --arg name "$name" '.identity == {kind:"acp-session",value:$name}' "$record" >/dev/null || exit "$EXIT_UNRELIABLE"
for tool in acpx jq timeout; do
    command -v "$tool" >/dev/null || { printf 'required tool is missing: %s\n' "$tool" >&2; exit "$EXIT_UNRELIABLE"; }
done
metadata="$(timeout --foreground -k 2 10 acpx --cwd "$cwd" --format json "$agent" sessions show "$name")" || {
    printf 'cannot read ACP session %s\n' "$name" >&2; exit "$EXIT_UNRELIABLE";
}
session_id="$(jq -er --arg name "$name" --arg cwd "$cwd" '
    select(.closed == false and .name == $name and .cwd == $cwd) | .acpxRecordId | strings | select(length > 0)
' <<<"$metadata")" || { printf 'ACP session %s is closed or mismatched\n' "$name" >&2; exit "$EXIT_SEND_REFUSED"; }

if [[ "$have_text" == true ]]; then
    delivery_receipt="REACH-RECEIPT-$(date +%s%N)-$$-$RANDOM"
    payload="First output exactly $delivery_receipt to confirm receipt. Then do this: $text"
    flags=()
    [[ "$no_wait" == false ]] || flags+=(--no-wait)
    response="$(printf '%s\n' "$payload" | timeout --foreground -k 2 "$((timeout_secs + 2))" acpx \
        --cwd "$cwd" --approve-all --format json --timeout "$timeout_secs" \
        "$agent" prompt -s "$name" "${flags[@]}" --file -)" || {
        prompt_status=$?
        case "$prompt_status" in
            3|124|137)
                printf 'ACP reply deadline elapsed for %s; inspect history before retrying\n' "$name" >&2
                exit "$EXIT_UNVERIFIED" ;;
            4) printf 'ACP session disappeared: %s\n' "$name" >&2; exit "$EXIT_UNRELIABLE" ;;
            *) printf 'ACP prompt failed for %s; inspect history before retrying\n' "$name" >&2; exit "$EXIT_SEND_REFUSED" ;;
        esac
    }
    verified=false
    output=''
    if [[ "$no_wait" == true ]]; then
        jq -se --arg id "$session_id" 'length == 1 and .[0].action == "prompt_queued" and
            .[0].acpxRecordId == $id and (.[0].requestId | type == "string" and length > 0)' \
            <<<"$response" >/dev/null || exit "$EXIT_SEND_REFUSED"
    else
        output="$(jq -sr '[.[] | select(.method == "session/update") | .params.update |
            select(.sessionUpdate == "agent_message_chunk" and .content.type == "text") |
            .content.text] | join("")' <<<"$response")" || exit "$EXIT_UNRELIABLE"
        if [[ "$output" == *"$delivery_receipt"* ]] &&
           { [[ -z "$expect" ]] || grep -Eq -- "$expect" <<<"$output"; }; then
            verified=true
        fi
    fi
    printf '%s' "$output" | jq -Rs --arg terminal "$terminal" --arg receipt "$delivery_receipt" \
        --argjson verified "$verified" '{ok:$verified,terminal:$terminal,sent:true,
        acceptedByRuntime:true,deliveryReceipt:$receipt,verified:$verified,output:.}'
    [[ "$verified" == true || "$no_wait" == true ]] || exit "$EXIT_UNVERIFIED"
    exit 0
fi

stream="$(jq -er '.eventLog.active_path | strings | select(startswith("/"))' <<<"$metadata")" || exit "$EXIT_UNRELIABLE"
[[ -f "$stream" && ! -L "$stream" && -r "$stream" ]] || {
    printf 'ACP event stream is unavailable for %s: %s\n' "$name" "$stream" >&2; exit "$EXIT_UNRELIABLE";
}
offset="$(stat -c %s -- "$stream")"
inode="$(stat -c '%d:%i' -- "$stream")"
if [[ -n "$since" ]]; then
    [[ "$since" == "$session_id":* && "${since#*:}" =~ ^[0-9]+$ ]] || {
        printf 'cursor does not belong to ACP session %s\n' "$name" >&2; exit "$EXIT_UNRELIABLE";
    }
    offset="${since#*:}"
fi
started=$SECONDS last_new=$SECONDS
match_tail=''
read_output=''
[[ "$follow" == false ]] || printf '# watching %s from cursor %s:%s\n' "$terminal" "$session_id" "$offset"
while :; do
    size="$(stat -c %s -- "$stream")" || exit "$EXIT_UNRELIABLE"
    if [[ "$(stat -c '%d:%i' -- "$stream")" != "$inode" || "$size" -lt "$offset" ]]; then
        printf 'ACP stream rotated or cursor is beyond retained data: %s\n' "$stream" >&2
        exit "$EXIT_UNRELIABLE"
    fi
    # Preserve newlines so a match cannot join text from separate log lines.
    chunk="$(dd if="$stream" bs=64K iflag=skip_bytes,count_bytes \
        skip="$offset" count="$((size - offset))" status=none && printf '.')"
    chunk="${chunk%.}"
    offset="$size"
    if [[ "$follow" == true ]]; then
        if [[ -n "$chunk" ]]; then
            printf '%s' "$chunk"
            last_new=$SECONDS
        fi
    else
        read_output+="$chunk"
        if [[ -z "$expect" ]] ||
           { [[ -n "$read_output" ]] && grep -Eq -- "$expect" <<<"$read_output"; }; then
            printf '%s' "$read_output" | jq -Rs --arg cursor "$session_id:$offset" \
                '{ok:true,output:sub("\n+$";""),cursorAfter:$cursor}'
            exit 0
        fi
    fi
    if [[ "$follow" == true && -n "$expect" ]]; then
        match_tail+="$chunk"
        if grep -Eq -- "$expect" <<<"$match_tail"; then exit 0; fi
        match_tail="${match_tail##*$'\n'}"
    fi
    if [[ -n "$idle_secs" ]] && ((SECONDS - last_new >= idle_secs)); then
        emit_watch_event idle "idleSeconds=$idle_secs"
        ring_or_fail idle "The ACP session produced no new output for ${idle_secs}s."
        break
    fi
    ((SECONDS - started < timeout_secs)) || break
    sleep "$poll_secs"
done
if [[ "$follow" == false && -n "$expect" ]]; then
    printf 'the read ended before new output matched --expect\n' >&2
    printf '%s' "$read_output" | jq -Rs --arg cursor "$session_id:$offset" \
        '{ok:false,output:sub("\n+$";""),cursorAfter:$cursor}' >&2
fi
[[ -z "$expect" ]] || exit "$EXIT_UNVERIFIED"
