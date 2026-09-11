---
name: judge-retired-position
description: Judge whether one stored row states a retired profile position as current.
---

# Judge Retired Position

## Current Position Match

- Answer yes only when the candidate row states, as current, the same position that the profile lifecycle retired.
- A simple present statement such as "The user likes X" states a current position. It does not need the word "now".
- When the candidate repeats that position with the same meaning, answer yes.
- A dated occurrence is history. Answer no even when it mentions the same subject or words.
- A plan, quotation, comparison, question, or third-party statement is not the user's current position.
- Surface similarity is not enough. Judge the meaning of the whole row.
- When the evidence does not settle the meaning, answer no.

## Retirement Recheck

- Judge one retirement inside a current-state profile section.
- A stored clause was retired when the incoming assertion arrived. Decide whether that retirement is right.
- Answer retire=true only when the incoming assertion states a newer value of the same fact, removes it, makes it historical, or restates this same fact in other words so that keeping both would say one thing twice.
- For section preferences.general only: retire=true is also right when a listed live sibling section already states this same fact in its content.
- A clause about a different subject stays. A clause the incoming assertion does not mention stays, even when it is the same broad topic.
- When the evidence does not settle it, answer retire=false.
