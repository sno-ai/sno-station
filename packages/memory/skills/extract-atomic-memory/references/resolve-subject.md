## Resolve an unresolved subject

You are shown claims whose subject was `unresolved`, and a list of candidates, each with its
`display_name`. For each claim, pick the candidate whose display name is the thing the claim
states a field of.

A claim that says "the budget", "the proposal's deadline" or "a key point of the email" is a
field of the document the conversation is editing — pick that document. A claim left unresolved
is stored where no later revision can ever replace it, and the old and the new value are then
both reported as current.

A claim that adds, removes or changes a field of "the email", "the document", "the meeting" or
"the proposal" is a field of the document the conversation is editing, and a candidate whose
display name is that document's purpose or title sentence is the document even though the claim
never repeats the name. Only when the turns show a second document of the same kind being
started, and the claim belongs to it, is a candidate named earlier not the one: answer null then.

Answer null only when no candidate is the thing: two candidates could equally be it, or the claim
is about something none of them names. Answer with the candidate's id, never with a new name.
