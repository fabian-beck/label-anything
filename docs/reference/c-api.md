# C API

`liblabelanything` (`.so`, `.dylib`, `.dll`, and a static `.a`) exports five functions. JSON
in, JSON out; every string returned through an out parameter must be released with
`la_free`. Usage: [C and Go](../getting-started/c-go.md).

[`rust/crates/la-capi/include/label_anything.h`](gh:rust/crates/la-capi/include/label_anything.h):

```c
--8<-- "rust/crates/la-capi/include/label_anything.h"
```

Built with the cargo feature `jni`, the same library also contains the JNI entry points
of the [Java binding](../bindings/java.md), which uses this C ABI on Java 22+ (FFM).
