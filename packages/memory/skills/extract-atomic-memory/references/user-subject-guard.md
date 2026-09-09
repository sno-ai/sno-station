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

Return one decision for every supplied record, in the same order.
