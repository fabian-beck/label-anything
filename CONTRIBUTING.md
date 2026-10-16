# Contributing to Label Anything

Thanks for helping! Label Anything is a label placement engine with two first-class
implementations (Rust and TypeScript) that follow one language-neutral spec.

## Ground rules

1. **Spec first.** Behaviour is defined in `spec/` (JSON Schemas, `defaults.md`,
   presets, `expr.peg`, `spec.md`). Change the spec in the same pull request as the code.
2. **Both implementations, one behaviour.** Implement in Rust first, port to TypeScript in
   the same pull request, and add a conformance case (`conformance/`). The two must never
   drift for more than one milestone.
3. **Every public option** needs documentation, a default (`spec/defaults.md`), a
   validation rule (both validators) and at least one conformance case.
4. **Generated files are never edited by hand.** Run `node tools/codegen.mjs` after
   touching `spec/defaults.md`, `spec/presets/` or `spec/schema/`; CI runs it with
   `--check`.
5. **Determinism.** No hash-map iteration in decisions, stable sorts with total
   comparators, only `+ − × ÷ sqrt` and `det_math` in float code (ADR 0007).
6. **Licenses.** Runtime dependencies must be MIT/Apache-2.0/BSD/ISC/Zlib-compatible.
   `node tools/check-licenses.mjs` enforces this.
7. **Benchmark first, optimize second.** Performance changes need an ADR with a profile
   note.
8. Decisions the brief leaves open are recorded as ADRs in `docs/adr/`.

## Development

```sh
# Rust
cd rust && cargo test --workspace && cargo clippy --workspace -- -D warnings
# TypeScript
cd ts && npm ci && npm run build && npm test
# Conformance (both)
cd rust && cargo test -p label-anything --test conformance
cd ts && npm run conformance
# Schema cross-check
python3 conformance/check_schema.py
```

## Commit messages

Imperative mood, one logical change per commit, prefixed with the area when useful
(`core:`, `ts:`, `spec:`, `bench:`, `bindings:`, `docs:`, `ci:`).

## Code of conduct

See `CODE_OF_CONDUCT.md`.
