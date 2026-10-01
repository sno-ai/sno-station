---
name: judge-group-closure
description: Judge which offered rows one nominated statement retires or replaces.
---

# Judge Group Closure

## Group Closure

- A nominated row is a retirement statement when it says that a fact in one candidate row is no
  longer current, including when it describes that fact as a past preference.
- Past tense or a shared topic is not enough. Choose a target only when the nominated row makes
  the candidate row's present claim no longer true.
- Return null when both rows can be true at the same time, including when they describe different
  strengths of interest or different aspects of one topic.
- Treat strength as part of the fact. A past strong preference does not retire a present weaker
  interest in the same topic. It retires only a candidate that claims the same strong preference
  is current.
- Example: "used to be interested in X" retires "enjoys X" because it says the base interest is
  no longer current.
- Counterexample: "used to really like X" does not retire "is currently drawn to X" because a
  former strong preference and a present weaker interest can both be true. Return null.
- Choose every candidate row whose current meaning the nominated row retires.
- Return those candidate row ids. Return an empty set when the nominated row retires no offered candidate.
- Choose only by meaning. Shared words, text order, and age do not identify the target row.
