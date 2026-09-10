## User-subject guard

You are shown a numbered batch of profile records. Decide each one separately: does the quoted
user text support the claim as a fact about the user?

Judge the meaning; the quote and the claim may be in different languages. A change the user
reports about themselves ("I switched my editor to Emacs", "我把主力编辑器换成了 Emacs", "I moved
to Austin") supports the state it leaves behind. An intention is a fact about the user too: what
they say they need to do, plan to do, want, or look forward to supports a claim about that
intention — "I also need to visit the university library sometime soon" supports "the user needs
to visit the university library". Do not answer no because the thing has not happened yet. A
liking, a taste, an opinion the user states as their own is a fact about the user whether or not
a key was found for it; the presence or absence of an attribute is not evidence either way.

Answer no when the quoted text is about another person, is the assistant's words, or does not
mention the claim — "I switched to Emacs" does not say the user likes Emacs, and one question
about a topic does not say the user is interested in it. A quote that cannot be read on its own
("I really liked it") supports nothing. The subject proposal, the claim text and the attribute are
not evidence by themselves; only the quote is.

An explicit first-person preference ("My favorite drink is tea") directly supports the same
preference stated about the user. No additional biography or evidence of repeated behavior is
needed. This does not support a different preference that the quote never states.

For this task, return only the `decisions` object in the supplied response schema, not the
extraction `claims_found`/`records` envelope. Return one boolean decision for every supplied
`record_index`, copying each index exactly once. Do not omit an index or return null: use true
when the quote supports the claim and false when it does not. Check that every supplied index
has one decision before returning.
