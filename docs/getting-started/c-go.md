# C and Go

`liblabelanything` exposes the Rust engine through a small C ABI: JSON text in, JSON text
out, and raster pixels by pointer. Any language with a C foreign function interface can
use it; this page shows C and Go (cgo). The header is [`label_anything.h`](#the-header).

| Function | |
|---|---|
| `la_place_json(problem, rgba, width, height, &result)` | solves; `rgba` may be `NULL`. `*result` is the result JSON, or a JSON array of `{pointer, code, message}` |
| `la_validate_json(problem, &report)` | validates: `{valid, errors, warnings}` |
| `la_render_svg(problem, result, &svg)` | draws the [debug overlay](../concepts/debug-overlay.md) |
| `la_version()` | a static string, e.g. `"0.1.0"` |
| `la_free(s)` | releases a string returned through an out parameter (`NULL` is a no-op) |

Return codes: `LA_OK` (0), `LA_INVALID` (1: the problem is invalid), `LA_ERROR` (2: any
other failure). Relative file paths in the JSON (`obstacles.svg.path`, a raster `source`,
a font `file`) resolve against the process's working directory.

## Build

From the root of a clone of the repository (Rust ≥ 1.88):

```sh
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi
# rust/target/release/liblabelanything.{so,dylib} (and .a), labelanything.dll on Windows
cc -std=c99 main.c -Irust/crates/la-capi/include -Lrust/target/release -llabelanything -o main
LD_LIBRARY_PATH=rust/target/release ./main      # macOS: DYLD_LIBRARY_PATH
```

`-llabelanything` links the shared library, which the loader must find at startup:
through `LD_LIBRARY_PATH` or a run path set at link time
(`-Wl,-rpath,$PWD/rust/target/release`). To link the static library instead, name the
archive and the system libraries it needs (Linux):

```sh
cc -std=c99 main.c -Irust/crates/la-capi/include rust/target/release/liblabelanything.a \
   -lm -lpthread -ldl -o main
# the system libraries for another platform:
cargo rustc --release --manifest-path rust/Cargo.toml -p label-anything-capi \
      --crate-type staticlib -- --print native-static-libs
```

## Threads

All functions can be called from several threads at once, without locking: calls share
no mutable state. The process shares only read-only data loaded once (the bundled fonts,
the schema, the defaults, …) and the worker pool (rayon) of each solve's data-parallel
phases, whose size `RAYON_NUM_THREADS` sets. Results depend neither on other calls nor on
the number of threads, unless the wall-clock guard stops a solve (`stats.time_guard_hit`).
A returned string may be released on any thread.

## C

```c
--8<-- "examples/tutorials/c/basics.c:place"
```

```c
--8<-- "examples/tutorials/c/basics.c:render"
```

Every string returned through an out parameter belongs to the library: release it once,
with `la_free`.

```c
--8<-- "examples/tutorials/c/basics.c:validate"
```

Raster pixels (row-major RGBA8, straight alpha, `width × height × 4` bytes) go in by
pointer, with no PNG or base64 encoding. They replace the image of the problem's first
`obstacles.raster` entry, whose options (`mode`, `scale`, `class`, …) still apply. That
entry needs a `source` to be valid, but the source is not read while pixels are passed:
any string will do (`"host"` below; with `rgba` `NULL`, it is read as a file path).
Without an `obstacles.raster` entry the pixels get the default options; without a
`canvas`, the canvas is the image size. The library copies the pixels during the call and
keeps no pointer to them.

```c
--8<-- "examples/tutorials/c/basics.c:pixels"
```

## Go

cgo compiles the C declarations in the comment above `import "C"`; the `#cgo` lines add
compiler and linker flags. `${SRCDIR}` is the Go file's directory, so here the flags point
to the header and the library in this repository.

```go
--8<-- "examples/tutorials/go/basics/main.go:cgo"
```

A small typed wrapper:

```go
--8<-- "examples/tutorials/go/basics/main.go:wrapper"
```

An omitted label has `placed: false`, a `reason` and no `box`:

```go
--8<-- "examples/tutorials/go/basics/main.go:use"
```

```go
--8<-- "examples/tutorials/go/basics/main.go:invalid"
```

Build and run (cgo needs a C compiler; the library is linked dynamically, so the loader
must find it at startup):

```sh
cd examples/tutorials/go
go build -o la-basics ./basics
LD_LIBRARY_PATH=../../../rust/target/release ./la-basics      # macOS: DYLD_LIBRARY_PATH
```

In your own module, shorten the `#cgo` lines to `#cgo LDFLAGS: -llabelanything` and pass
the paths through the environment, or write absolute paths into them:

```sh
LA=$HOME/label-anything                  # the repository, with the library built
export CGO_CFLAGS="-I$LA/rust/crates/la-capi/include"
export CGO_LDFLAGS="-L$LA/rust/target/release"
go build -o myapp .
LD_LIBRARY_PATH=$LA/rust/target/release ./myapp
```

To pass pixels from a `[]byte`, give `la_place_json` `(*C.uint8_t)(unsafe.Pointer(&pix[0]))`:
C may read Go memory that contains no Go pointers, for the duration of the call.

## The header

Built with the cargo feature `jni`, the library also contains the JNI entry points of the
[Java binding](java.md), which uses this C ABI on Java 22+.

??? abstract "`rust/crates/la-capi/include/label_anything.h`"

    ```c
    --8<-- "rust/crates/la-capi/include/label_anything.h"
    ```

The programs on this page are in [`examples/tutorials/c`](gh:examples/tutorials/c) and
[`examples/tutorials/go`](gh:examples/tutorials/go) and run in CI.
