# Label Anything from Java

`Main.java` labels 40 towns on a raster background (passed to the native library by
pointer), with angled leaders and priority-driven omission, prints the result and writes
the debug overlay SVG. The guide is `docs/bindings/java.md`.

Run from the repository root:

```sh
# 1. The native library: the C ABI plus the JNI entry points (cargo feature `jni`)
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi --features jni

# 2. The JAR (JDK 22+ to build); it bundles rust/target/release/liblabelanything.so
mvn -f bindings/java/pom.xml package -DskipTests

# 3. Run: FFM on Java 22+, JNI on Java 17-21
java --enable-native-access=ALL-UNNAMED \
     -cp bindings/java/target/label-anything-0.1.0.jar examples/java/Main.java overlay.svg

# Force the JNI path on Java 22+, or load the library from the build directory
java --enable-native-access=ALL-UNNAMED -Dlabelanything.backend=jni \
     -Dlabelanything.library.path=rust/target/release \
     -cp bindings/java/target/label-anything-0.1.0.jar examples/java/Main.java overlay.svg
```

Expected output (numbers vary slightly with the machine only in the runtime):

```
label-anything 0.1.0 via ffm
placed 40 of 40 labels, hard violations 0, LOCAL, ... ms
  t0   Town 0       ADJACENT  TOP        box=(...)
  ...
debug overlay: /.../overlay.svg
invalid: /canvas/width [range] ...
invalid: /items/0/label/padding [unit] ...
```
