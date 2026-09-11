---
name: resolve-relative-time
description: Resolve relative time phrases in extracted memories against supplied session metadata without inventing dates.
---

# Resolve Relative Time

Use the supplied session metadata as the only clock for relative dates.

## With Session Anchor

A session anchor is provided above as `session_date_time`.

- Resolve relative time phrases to absolute dates in the session timezone.
- "today" is the session calendar date. Do not move it back one day.
- "yesterday" is one day before the session date.
- "the day before yesterday" is two days before the session date.
- "last week" is the prior week, "last month" is the prior month, and "last year" is the prior year.
- Resolve "N days ago", "N weekends ago", and "last [weekday]" from the session date.
- "next [weekday]" is that weekday in the week after the session's week, never the nearest one
  ahead: from Monday 2026-06-02, "next Thursday" is 2026-06-11. "this [weekday]" or a bare weekday
  is the nearest one ahead.
- When an absolute date and a relative phrase describe the same occurrence of the same event, keep
  the absolute date. Otherwise, resolve each relative phrase against the session anchor for its own
  event. Do not infer that two events are the same because their dates appear next to each other.
- If the arithmetic is ambiguous, keep both the relative phrase and the resolved date.
- Never leave only a relative phrase when the session anchor makes an absolute date available.

Examples:

- Session `2023-05-14T10:00:00`; "painted a lake sunrise last year" becomes "Painted a lake sunrise in 2022".
- Session `2026-06-05T14:00:00`; "walked 8,578 steps today" becomes "Walked 8,578 steps on 2026-06-05".
- Session `2023-07-17T18:00:00`; "camping two weekends ago" can become "Camping the weekend of 2023-07-01 (two weekends before 2023-07-17)".

## Without Session Anchor

No `session_date_time` was provided for this extraction. Do NOT invent or guess absolute dates.

- Keep a relative time phrase verbatim.
- Mark the timing as unresolved when that improves clarity.
- Do not replace it with a guessed calendar date or year.
- If the source gives its own absolute date, keep that date and optionally keep both forms.
