# C and Go

`liblabelanything` exposes the Rust engine through a small C ABI: JSON text in, JSON text
out, plus an entry point that takes raster pixels by pointer. Every language with a C
foreign function interface can use it; this page shows C and Go (cgo). The header is
[`label_anything.h`](../reference/c-api.md).

| Function | |
|---|---|
| `la_place_json(problem, rgba, width, height, &result)` | Solve; `rgba` may be `NULL`. `*result` is the result JSON, or a JSON array of `{pointer, code, message}` |
| `la_validate_json(problem, &report)` | `{valid, errors, warnings}` |
| `la_render_svg(problem, result, &svg)` | The [debug overlay](../concepts/debug-overlay.md) |
| `la_version()` | A static string, e.g. `"0.1.0"` |
| `la_free(s)` | Release a string returned through an out parameter (`NULL` is a no-op) |

Return codes: `LA_OK` (0), `LA_INVALID` (1, the problem is invalid), `LA_ERROR` (2, any
other failure). Relative file paths in the JSON (`obstacles.svg.path`, a raster `source`,
a font `file`) resolve against the process's working directory.

## Build

```sh
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi
# rust/target/release/liblabelanything.{so,dylib} (and .a), labelanything.dll on Windows
cc -std=c99 main.c -Irust/crates/la-capi/include -Lrust/target/release -llabelanything -o main
LD_LIBRARY_PATH=rust/target/release ./main
```

## C

```c
--8<-- "examples/tutorials/c/basics.c:place"
```

```c
--8<-- "examples/tutorials/c/basics.c:render"
```

Every string returned through an out parameter belongs to the library: release it with
`la_free`, exactly once.

```c
--8<-- "examples/tutorials/c/basics.c:validate"
```

Raster pixels (row-major RGBA8, straight alpha) replace the image of the problem's first
`obstacles.raster` entry, whose options still apply; without a `canvas`, the canvas is the
pixel size.

```c
--8<-- "examples/tutorials/c/basics.c:pixels"
```

## Go

A small typed wrapper with cgo; the `#cgo` lines point at the header and the library (for
an installed library, use its include and library paths).

```go
--8<-- "examples/tutorials/go/basics/main.go:wrapper"
```

```go
--8<-- "examples/tutorials/go/basics/main.go:use"
```

```go
--8<-- "examples/tutorials/go/basics/main.go:invalid"
```

All programs on this page are in [`examples/tutorials/c`](gh:examples/tutorials/c) and
[`examples/tutorials/go`](gh:examples/tutorials/go) and run in CI.
