# 0017 — Cancellation and progress

* Status: accepted (spec §10.3a)
* Date: 2026-10-16

## Context
Brief §6.4 asks for `progress(phase, fraction)` and cancellation tokens (an
`AbortSignal` in JavaScript). Bindings call the solver synchronously; cancellation must
be cheap to poll (host callbacks may cross a language boundary) and must never produce
an invalid result.

## Decision
The core polls `Env::cancelled` at every priority band and every 64 items of the greedy
pass, every 256 local-search moves and every 4,096 exact-search nodes. Once cancelled it
stops improving: the greedy pass places no further items (reported as
`budget_exhausted`), the searches keep their best state, and repair and verification
still run; `stats.cancelled` is `true`. Progress is reported per greedy band and every
256 local-search moves.

## Consequences
A cancelled solve returns quickly with a valid, possibly partial result. In a
synchronous JavaScript call an `AbortSignal` cannot change during the call; it matters
for Web Worker and asynchronous hosts.
