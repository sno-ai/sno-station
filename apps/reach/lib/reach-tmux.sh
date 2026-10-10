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
