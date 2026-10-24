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
| `la_free(s)` | releases a string returned through an out parameter, exactly once (`NULL` is a no-op) |

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

All functions can be called from several threads at once, without locking, and a
returned string may be released on any thread. Each solve runs its data-parallel phases on
a worker pool whose size `RAYON_NUM_THREADS` sets; results do not depend on it, unless the
wall-clock guard stops a solve (`stats.time_guard_hit`).

## C

```c
--8<-- "examples/tutorials/c/basics.c:place"
```

```c
--8<-- "examples/tutorials/c/basics.c:render"
```

```c
--8<-- "examples/tutorials/c/basics.c:validate"
```

Raster pixels (`width × height × 4` bytes) replace the image of the problem's first
`obstacles.raster` entry, whose options (`mode`, `scale`, `class`, …) still apply. That
entry needs a `source` to be valid, but with pixels passed it is not read (with `rgba`
`NULL`, it is read as a file path). Without such an entry, the pixels get the default
options; without a `canvas`, the canvas is the image size.

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

Build and run (cgo needs a C compiler):

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
[`examples/tutorials/go`](gh:examples/tutorials/go).
