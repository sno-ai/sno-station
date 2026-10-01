---
name: resolve-entity-identity
description: Resolve a new entity display name to an existing entity id or to a new entity.
---

# Resolve Entity Identity

## Entity Identity

- You are shown one new display name and the project's existing entity display names.
- Answer with an existing entity id only when the new display name identifies that same entity.
- The same entity is very often written more than one way. A shortening ("ACME Rebrand" for
  "Acme Corp Rebrand"), a change of case or spacing, an added or dropped type word ("… project",
  "… proposal", "… email"), an added or dropped honorific, or the name wrapped in quotes all
  name the SAME entity. Answer that entity's id.
- Otherwise answer `new`.
- Answer `new` when you are in doubt whether two different things are meant — two people who
  share a surname, two documents with similar titles. A different spelling of one name is not
  doubt.
- A wrong merge silently fuses the facts of two people or two documents.
- A wrong split leaves two current values for a thing that can only have one — two budgets for
  one project — and both are served as true.
- Return exactly one JSON object and no prose: `{ "entity_id": "new" }`.
- Set `entity_id` to `new` or to one entity id shown with the existing display names.
