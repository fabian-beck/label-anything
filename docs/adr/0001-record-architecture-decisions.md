# 0001 — Record architecture decisions

* Status: accepted
* Date: 2026-10-16

## Context
The design brief leaves many decisions open and asks that each one is recorded instead
of being escalated.

## Decision
We keep lightweight ADRs in `docs/adr/NNNN-title.md` (Context, Decision, Consequences).
An ADR is required for: every open point of the brief we decide, every deviation from the
brief, every performance change (with a profile note), and every benchmark-metric
regression > 2 % that we accept.

## Consequences
The `docs/adr/` directory is the decision log. Superseded ADRs stay, marked
"superseded by NNNN".
