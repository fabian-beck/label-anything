# Architecture decisions

Why the engine and the project around it are the way they are. Each decision is recorded
as an ADR in [`docs/adr/`](gh:docs/adr): its **context** (the problem, often with what was
measured), the **decision**, the **alternatives considered** and the **consequences**,
good and bad.

A few fields head every ADR:

* **Status**: `accepted`, or `rejected` for an idea that was measured and not adopted; it
  stays as the record of why.
* **Area**: the part of the engine or the project it is about. The tables below are
  grouped by it.
* **Affects**: the spec sections, packages and files it changed, and whether results
  change.
* **Amends / Amended by**: merged ADRs are not rewritten, so read an ADR together with
  the later ones that changed part of it.

[ADR 0051](../adr/0051-adr-format-metadata-and-scope.md) sets out the format and what
needs an ADR; new ADRs follow its template.

<!-- la:adr-index -->
