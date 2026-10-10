#!/usr/bin/env bash
# Sourced library: preserve the caller's shell options.
wait_openclaw_idle() {
    local pane="$1" deadline=$((SECONDS + 60)) screen
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
