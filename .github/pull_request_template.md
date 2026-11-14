## What changes

<!-- What a user of the engine sees: placements, formats, options, APIs. -->

## Checklist

- [ ] Spec and code agree: `spec/` changed with the behaviour, `node tools/codegen.mjs` run.
- [ ] Rust and TypeScript both changed, with a conformance case (`conformance/`).
- [ ] New options are documented, have a default (`spec/defaults.md`) and a validation rule.
- [ ] Tests pass: `cargo test --workspace`, `npm test`, `npm run conformance`.
- [ ] A decision record (`docs/adr/`) for a changed result, format, option or public API.
- [ ] `CHANGELOG.md` says what users will notice.
