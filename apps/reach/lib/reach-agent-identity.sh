# shellcheck shell=bash
# Who is asking is the nearest agent above this process. CLAUDECODE and CLAUDE_PID are inherited by
# everything a Claude Code conversation starts, so an agent such as Codex started from Claude is
# its own agent, and a Claude Code background session (a fork, --bg or a reused spare) is not the
# conversation it came from.

# Prints claude-code, codex, cursor, hermes or openclaw for the nearest agent, or nothing.
nearest_agent() {
    local pid=$$ comm
    while [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)); do
        if [[ -n "${CLAUDE_PID:-}" && "$pid" == "$CLAUDE_PID" ]]; then
            printf 'claude-code\n'
            return
        fi
        comm="$(ps -o comm= -p "$pid" 2>/dev/null)"
        case "${comm##*/}" in
            codex | codex-*) printf 'codex\n'; return ;;
            cursor-agent) printf 'cursor\n'; return ;;
            hermes) printf 'hermes\n'; return ;;
            openclaw) printf 'openclaw\n'; return ;;
        esac
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    done
}

# True when the nearest agent is a Claude Code background session.
claude_background_session() {
    [[ "$(nearest_agent)" == claude-code ]] &&
        [[ "$(jq -r '.kind // empty' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$CLAUDE_PID.json" 2>/dev/null)" == bg ]]
}

# True when a Codex app-server is above this process. One app-server runs the tools and hooks of every
# Codex window of a user, and its terminal variables are those of the window that started it.
codex_app_server() {
    local pid=$$ comm
    while [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 1)); do
        comm="$(ps -o comm= -p "$pid" 2>/dev/null)"
        case "${comm##*/}" in
            codex | codex-*) [[ " $(ps -o args= -p "$pid" 2>/dev/null) " != *" app-server "* ]] || return 0 ;;
        esac
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    done
    return 1
}
