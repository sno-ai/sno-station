# Understand time; delegate arithmetic

Read the complete conversation and the claim before deciding its time. A word by itself does
not say whether something is past, future, ongoing, hypothetical, quoted, or about another event.
Return one structured calendar instruction in `time`, and another in `ended_time` only for an
ending. Copy the supporting words into `temporal_phrase` / `ended_at_phrase`. Keep the claim
wording and its duration. Do not calculate a year, a date, a weekday offset, or an epoch yourself.
Not knowing when an event happened does not erase that event: keep its record with `unresolved`.

- `none`: a standing fact with no temporal assertion. An undated historical event is instead
  `unresolved`. Do not label an event as happening now merely because the speaker reports it now.
- `unresolved`: the event time or its reference cannot be established from the supplied context.
  This includes a duration with no known endpoint. Keep the fact and its uncertainty.
- `absolute`: copy the calendar components stated by the speaker into `year`, `month`, `day`,
  `hour`, `minute` as applicable. A missing year may use the session year only when the context
  establishes that year. Never fill an unknown month or day.
- `relative`: give the signed `amount` and `unit` relative to the session. Negative means before,
  positive means after. The code adds or subtracts. For "I've known them for four years, since I
  moved", the start/move is `amount: -4, unit: year`, not a future event. For a future four-year
  course, distinguish its start from its end; a four-year duration alone does not date either.
  When the statement links the start of a duration to another event, both events share that
  start. In the friendship-and-move example, both the friendship start and the move receive
  the same negative four-year instruction; the move is not undated. Judge that relationship
  from the whole statement, not from whether each split claim repeats the time words.
  The amount is a number the words state. "Recently", "lately", "a while ago", "a few weeks
  ago", "the other day" and "soon" state none: they are `unresolved`, never a guessed number.
- `weekday`: give `weekday` (Monday 1 through Sunday 7) and `direction` (`previous` or `next`)
  for a strictly preceding/following occurrence. Read abbreviations, spelling, language and the
  speaker's intended reference in context. The code finds that weekday; do not count days.

For resolved instructions give `precision`: `year`, `month`, `week`, `day`, or `minute`.
Preserve what is actually known. "Four years ago" normally supplies a year, not an anniversary
day. A named weekday supplies a day. A dated event with a stated clock supplies a minute.
`relative` amount 0 is available when the text establishes the event as current. Use `hour` and
`minute` for a stated clock on a relative day or weekday. Use `timezone` only when the source
names it; otherwise the code uses the session zone. The timezone field is a valid IANA zone
identifier or a fixed offset written as `+HH:MM` or `-HH:MM`, never an abbreviation. Interpret
an abbreviation from its context into that identifier or offset, and keep the stated hour and
minute unchanged. The code converts between zones. If the abbreviation is ambiguous in context,
return `unresolved`. For an unknown clock do not choose noon.

Resolve references from the full context, but do not borrow another event's time merely because
it is nearby. An explicit date for this same event supplies its date; an adjacent event keeps
its own. If the intended reference cannot be expressed by the supplied operations, use
`unresolved` rather than calculating an answer or inventing a new field.

For example, "That exhibition inspired me. Today I shared its photo" dates the sharing today,
not the inspiration. Without words dating the inspiration, keep its time unresolved. If an
earlier turn explicitly dates that same exhibition to last Friday, retain the weekday
instruction for the exhibition; never replace it with a guessed number of days. Copy the
actual dating words into `temporal_phrase`, not a clause that merely names the experience.

A weekend is a span, not an exact Saturday or Sunday, and no precision names it: keep the
weekend phrase and use `unresolved`; do not narrow it to a single weekday. A week is not a
weekend: "last week" is `relative`, `amount: -1`, `unit: week`, `precision: week`; the code
turns that into the week's date range.
