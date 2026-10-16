# The design brief's examples

The examples of the design brief, run as written in CI (milestone M5: "the examples in §6
run verbatim in CI"):

| Brief | File | CI job |
|---|---|---|
| §6.1 Python one-call API | `python_6_1.py` (a prelude creates the inputs it assumes) | `python` |
| §6.5 CLI (place, CSV mode, render to SVG/PNG, validate, stdin/stdout, serve) | `cli_6_5.sh` (+ `make_inputs.py`) | `examples` |
| §6.2 JavaScript/TypeScript | follows with `@label-anything/core` (`place`) and `@label-anything/wasm` | — |
| §6.3 Java builder | `java/Brief63.java` (a prelude creates `map.png`; run with `java/run.sh <jar>`) | `java` |

The C and Go programs of §6.3 are `examples/c` and `examples/go`.
