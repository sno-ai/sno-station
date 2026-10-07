# REVIEW.md — the pull request review contract

This is the one contract every reviewer of a pull request applies: the Claude review job in CI,
the Codex GitHub app, and a person. It governs the formal review at the pull request: judgment
over the diff.

## Passes

Run three passes over the diff, reading the full files around it, and tag each finding
with its pass:

- **Bugs** — logic errors, broken edge cases on a reachable path, subtle regressions.
- **Security and data** — injection, authentication or authorization gaps, secrets or PII in
  logs, data loss, wrong writes, corrupted or duplicated state, broken persistence guarantees.
- **Contract** — the change diverges from the PR's stated intent, the current product
  contract, or documented runtime behavior.

## What counts as a finding

Report an issue only when a realistic trigger reaches it and the consequence is material:

- **User journey blocker** — a reachable workflow stops, fails irrecoverably, or prevents the
  user from completing the intended task.
- **Functional contract mismatch** — behavior materially diverges from intent or contract.
- **Liveness failure** — reachable code can hang, deadlock, crash, or exit unexpectedly.
- **Data integrity failure** — reachable code can lose, corrupt, or duplicate data.
- **Maintainability blocker** — a changed file or function is so large, branch-heavy, or
  below the surrounding readability baseline that the next fix is likely to be unsafe.
  Never use this for ordinary style.

Backward compatibility is not a default requirement. Do not request legacy inputs, legacy
configuration, migrations, or compatibility shims unless the current public contract, the
PR description, or a named migration requirement says legacy behavior must still work.

## Severity

- **CRITICAL** — data loss or corruption, security bypass, production outage, or a guaranteed
  user journey failure.
- **HIGH** — reachable hang or crash, serious contract mismatch, or a high-risk regression on a
  common path.
- **MEDIUM** — a clear maintainability blocker in changed code, or a less common but reachable
  failure under this contract.

There is no LOW. Style, naming, and import order are nits; report at most five nits per
review, as one grouped comment, and never as blocking.

## Do not report

- Formatting, naming style, import order — linters own these.
- Anything a type checker, linter, or the test suite already catches.
- Pre-existing issues the PR did not introduce.
- Speculative hardening or theoretical edge cases with no reachable failure path.
- Backward-compatibility work the current contract does not require.
- Generated files and vendored code.
- Commit sign-off (`Signed-off-by`) and other commit-message conventions.

## Output

- Findings only. Never praise the code. Never summarize what the PR does.
- One finding per comment, one paragraph: severity, the reachable path, the user impact, the
  smallest concrete fix.
- No findings: say exactly "No release-blocking issues found."
- Be concise; sacrifice grammar for clarity.
