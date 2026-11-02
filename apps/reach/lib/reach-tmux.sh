#!/usr/bin/env bash
# Sourced library: preserve the caller's shell options.
wait_openclaw_idle() {
    local pane="$1" budget="${2:-60}" deadline screen
    ((budget <= 60)) || budget=60
    deadline=$((SECONDS + budget))
    while ((SECONDS < deadline)); do
        screen="$(timeout --foreground 2 tmux capture-pane -p -t "$pane" 2>/dev/null || true)"
        if grep 'connected' <<<"$screen" | tail -n 1 |
           grep -Eq 'connected[[:space:]]*\|[[:space:]]*idle([[:space:]]|$)'; then
            return 0
        fi
        sleep 2
    done
    printf 'reach: openclaw seat never reached idle: %s; delivering anyway\n' "$pane" >&2
}

# Reads a screen on stdin and prints what the input box of a coding agent holds: the text after
# the last prompt mark (› or ❯), with dimmed spans removed. An empty box shows a dimmed
# placeholder or suggestion, while typed text is not dimmed (measured on Claude Code 2.1 and
# Codex 0.166 with `tmux capture-pane -e`). A screen without escapes keeps a placeholder.
composer_text() {
    perl -CSD -ne '
        $last = $1 if /^\s*(?:\e\[[0-9;]*m)*[\x{203A}\x{276F}](.*)$/;
        END {
            $last //= q{};
            $last =~ s/\e\[2m.*?(?:\e\[(?:0|22)?m|\z)//g;
            $last =~ s/\e\[[0-9;?]*[ -\/]*[@-~]//g;
            $last =~ s/^[\s\x{A0}]+|[\s\x{A0}]+$//g;
            print $last;
        }'
}

# Succeeds when the input-box text was typed by a person. A leftover of what Reach itself types
# is not a draft and may be cleared; a person's draft is never erased or sent with a message.
# Codex's placeholder is named too, for a screen that does not dim it.
is_person_draft() {
    [[ -n "$1" && "$1" != 'Ask Codex to do anything' &&
       ! "$1" =~ ^(/queue\ )?(REACH-RING|First\ output\ exactly\ REACH-RECEIPT-) ]]
}
