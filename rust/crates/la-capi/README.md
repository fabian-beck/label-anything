# label-anything-capi

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The C ABI of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps and
diagrams: JSON text in, JSON text out, and optionally a raster background as raw RGBA
pixels by pointer. The crate builds `liblabelanything` as a shared and a static library;
the header is `include/label_anything.h`.

```c
#include "label_anything.h"

char *result = NULL;
int32_t rc = la_place_json(problem_json, NULL, 0, 0, &result); /* LA_OK, LA_INVALID, LA_ERROR */
puts(result);    /* the result, or a JSON array of errors */
la_free(result);
```

Every function may be called from several threads at once; every returned string is
released with `la_free`. With the feature `jni` the library also exports the JNI entry
points of the Java binding (`io.github.fabian-beck:label-anything`).

```sh
cargo build --release -p label-anything-capi      # target/release/liblabelanything.{so,dylib,dll,a}
```

The guide, with examples in C and Go:
[C and Go](https://fabian-beck.github.io/label-anything/getting-started/c-go/).

MIT License.
