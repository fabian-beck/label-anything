# Label Anything from Java

`Main.java` labels 40 towns on a raster background (passed to the native library by
pointer), with angled leaders and priority-driven omission, prints the result and writes
the debug overlay SVG. The guide is `docs/bindings/java.md`.

Run from the repository root:

```sh
# 1. The native library: the C ABI plus the JNI entry points (cargo feature `jni`)
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi --features jni

# 2. The JAR (JDK 22+ to build); it bundles rust/target/release/liblabelanything.so.
#    Only JDK 17-21 at hand: compile the JNI path with javac instead, as in
#    docs/getting-started/java.md, and add -Dlabelanything.library.path=rust/target/release
mvn -f bindings/java/pom.xml package -DskipTests

# 3. Run: FFM on Java 22+, JNI on Java 17-21
java --enable-native-access=ALL-UNNAMED \
     -cp bindings/java/target/label-anything-0.1.0.jar examples/java/Main.java overlay.svg

# Force the JNI path on Java 22+, or load the library from the build directory
java --enable-native-access=ALL-UNNAMED -Dlabelanything.backend=jni \
     -Dlabelanything.library.path=rust/target/release \
     -cp bindings/java/target/label-anything-0.1.0.jar examples/java/Main.java overlay.svg
```

Output (version 0.1.0; on Java 22+ the first line ends in `via ffm`, the runtime varies,
and the placements can change with the engine version):

```
label-anything 0.1.0 via jni
placed 34 of 40 labels, hard violations 0, LOCAL, 30.1 ms
  t0   T0           ADJACENT  BOTTOM     box=(456.7, 140.0, 14.6 x 17.0)
  t1   Town 1       SLIDER    TOP_RIGHT  box=(486.2, 89.1, 43.3 x 19.9)
  t2   Town 2       ADJACENT  LEFT       box=(396.7, 106.0, 43.3 x 19.9)
  t3   Town 3       DISTANT   DISTANT    box=(437.4, 77.6, 43.3 x 19.9) leader 2 points
  t4   T4           DISTANT   DISTANT    box=(447.4, 209.5, 17.1 x 19.9) leader 2 points
  t5   Town 5       ADJACENT  LEFT       box=(386.7, 140.0, 43.3 x 19.9)
  t6   T6           SLIDER    TOP        box=(466.8, 103.0, 14.6 x 17.0)
  t7   omitted (OMITTED_BY_PRIORITY)
  t8   Town 8       SLIDER    BOTTOM     box=(408.4, 163.0, 43.3 x 19.9)
  t9   Town 9       ADJACENT  BOTTOM     box=(457.4, 160.0, 43.3 x 19.9)
  t10  omitted (OMITTED_BY_PRIORITY)
  t11  omitted (OMITTED_BY_PRIORITY)
  t12  omitted (NO_FEASIBLE_CANDIDATE)
  t13  omitted (NO_FEASIBLE_CANDIDATE)
  t14  omitted (OMITTED_BY_PRIORITY)
  t15  T15          ADJACENT  RIGHT      box=(488.0, 126.0, 24.0 x 19.9)
omission order (lowest priority first): [t13, t12, t14, t10, t11, t7]
debug overlay: /.../overlay.svg
invalid: /canvas/width [range] must be > 0
invalid: /items/0/label/padding [unit] invalid length "3qq": use a number (px) or <number>px|pt|em
```
