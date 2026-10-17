# Java

`io.github.fabian-beck:label-anything` is the Java binding of the Rust engine
(`bindings/java`). It has no runtime dependencies: a builder emits the problem JSON, the
native library `liblabelanything` solves it, and the result is parsed into records.

* **Java 22+** calls the C ABI (`label_anything.h`) through the Foreign Function & Memory
  API (`Linker.nativeLinker()`).
* **Java 17–21** uses JNI. The JAR is a multi-release JAR: the base classes contain the JNI
  path, `META-INF/versions/22` the FFM path. Both call the same Rust functions and return
  identical results (tested).

## Install

```xml
<dependency>
  <groupId>io.github.fabian-beck</groupId>
  <artifactId>label-anything</artifactId>
  <version>0.1.0</version>
</dependency>
```

Start the JVM with `--enable-native-access=ALL-UNNAMED` (Java 22+ warns about restricted
methods without it; executable JARs can set `Enable-Native-Access: ALL-UNNAMED` in their
manifest instead).

From source (Rust ≥ 1.88, JDK 22+ to build, Maven 3.9):

```sh
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi --features jni
mvn -f bindings/java/pom.xml verify      # JAR in bindings/java/target/, bundles the library
```

`verify` runs the unit tests, then the integration tests twice against the packaged JAR:
once with FFM, once with JNI (`-Dlabelanything.jni.jvm=/path/to/jdk17/bin/java` runs the
JNI pass on an older JVM). The integration tests compare FFM, JNI and the CLI
(`cargo build --release -p label-anything-cli`) on every conformance problem.

## Quick start

```java
import io.github.fabianbeck.labelanything.*;

var problem = LabelProblem.builder()
    .canvas(800, 600).fontSize(12)
    .item("A", 120, 80, Label.text("Alpha"))
    .backgroundRaster(Path.of("map.png"), RasterMode.INK)
    .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
    .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
    .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
    .omission(Omission.STRICT)
    .build();
LabelResult r = LabelAnything.place(problem);

for (LabelPlacement p : r.placements()) {
  if (p.placed()) {
    System.out.println(p.id() + " " + p.box() + " " + p.anchorSide() + " " + p.lines());
  } else {
    System.out.println(p.id() + " omitted: " + p.reason());
  }
}
System.out.println(r.omissionOrder());               // lowest priority first
Files.writeString(Path.of("debug.svg"), LabelAnything.renderSvg(problem, r));
```

`examples/java/Main.java` is a complete program; `examples/brief/java/Brief63.java` runs
the snippet above verbatim in CI.

## Building a problem

Every builder method maps to a field of `spec/schema/problem.v1.json`; unset options keep
the defaults of `spec/defaults.md`. Option objects (`Label`, `Mark`, `Leaders`, ...) are
immutable: each fluent call returns a new object. Lengths take a number (px) or a string
with a unit (`"0.5em"`, `"3px"`, `"2pt"`).

| Builder | Problem JSON |
|---|---|
| `canvas(w, h)`, `canvasPadding`, `allowOutside`, `region`, `devicePixelRatio`, `yAxisUp()`, `transform(a..f)`, `preset(Preset)` | `canvas`, `y_axis`, `transform`, `preset` |
| `fontSize`, `font(Font.of("default").size(14).bold().lineHeight(1.3))`, `labelPadding`, `buffer`, `margin`, `defaultMark(Mark)`, `wrap(Wrap)`, `truncate(Truncate)`, `textShaping` | `defaults.*`, `text.shaping` |
| `item(id, x, y, label)`, `item(id, x, y, label, it -> it.mark(..).attr(..))`, `item(Item.point(..)...)`, `area(id, polygon, label)`, `items(...)` | `items` |
| `backgroundRaster(Path, RasterMode)`, `backgroundRaster(byte[] png, mode)`, `backgroundPixels(w, h, ByteBuffer/byte[], mode)`, `background(Raster...)`, `backgroundSvg(String/Path)`, `background(Svg...)`, `vector(VectorLayer)` | `obstacles.*` |
| `avoid(Avoid.label().hard(..).weight(..), Avoid.leader()..., Avoid.buffer()..., Avoid.relaxable(..))` | `avoid.*` (merged key by key) |
| `leaders(Leaders.straight()/angles(..)/orthogonal()/elbow(..)/curved().port(..).clearance(..))` | `leaders` |
| `placement(Placement.models(Model...).maxDistance("10em").boundarySides(..))` | `placement` |
| `priority(Priority)`, `tier(where, tier)`, `omission(Omission)`, `coverage(by, n)`, `ties`, `tiesRandom(seed)`, `band`, `maxLabels`, `maxInkFraction`, `focus`, `fontClasses(FontClass...)` (`FontClass.share(5, 1.3).bold()`, `FontClass.first(10, 1.1)`, `FontClass.rest(0.9)`) | `priority.*` |
| `timeBudgetMs`, `seed`, `strategy(Strategy)`, `maxIterations`, `gridCell` | `solver.*` |
| `degrade(Degrade.ALTERNATIVES, Degrade.shrink(0.85), ...)`, `minScale`, `wrapMaxLines`, `softOverlapWeight` | `degrade`, `degrade_options.*` |
| `weights(Weights.defaults().position(1))`, `warmStart(previousResult)` | `weights`, `warm_start` |
| `debugSvg`, `costBreakdown`, `reportCandidates`, `itemShape` | `output.*` |
| `option("placement.k_distant", 12)` | any field by its dotted path |

Items: `Item.point(id, x, y)` or `Item.area(id, polygon)` with `label`, `mark`
(`Mark.circle/ellipse/rect/polygon/path/icon/fromSvg`), `attr`/`attrs`, `priority`,
`tier`, `required`, `group`, `keepWith(set)`, `keepWithItems(ids...)`, `svgId`,
`placement`. Labels: `Label.text(..)` (with `alternatives`, `wrap`, `truncate`, `font`,
`fontSize`, `padding`, `size`/`lines` for host-measured text, `align`), `Label.icon(w, h)`,
`Label.box(w, h)` (`rect()`, `circle()`, `rounded(r)`, `polygon(..)`), and
`Label.composite(parts...)` (`row()`, `column()`, `gap`, `align`).

`problem.toJson()` is the JSON sent to the engine; `problem.toPortableJson()` is the
same, self-contained (raw pixels embedded), e.g. for `label-anything place`.

### Priority

`Priority` is a weighted sum of terms evaluated by the engine: `attr(name)`,
`expr("attrs.cbo * 2")`, `outlierness(k)`, `isolation()`, `crowding()`, `labelSize()`,
`markSize()`, `centrality()`, `degree()`, `inputOrder()`. A term takes a transform
(`log1p()`, `sqrt()`, `neg()`, `abs()`), `normalize(..)`, `weight(w)` and `k(n)`; terms
combine with `plus`, `minus` and `times`:

```java
Priority.attr("cbo").log1p().times(0.5).plus(Priority.outlierness(5)).minus(Priority.labelSize().times(0.2))
```

`Priority.callback(item -> ...)` computes the score in Java: it runs once per item when
the problem is built and writes an explicit `priority` into every item that has none
(callbacks combine with callbacks, not with engine terms).

### Raster pixels without copies

`backgroundPixels(width, height, buffer, mode)` (or `Raster.pixels(..)`, `Raster.argb(..)`)
passes row-major RGBA8 pixels (straight alpha) to the pointer entry point of
`la_place_json`: no base64, no image decoding. A direct `ByteBuffer` (for example
`ByteBuffer.allocateDirect` or `MemorySegment.asByteBuffer()`) is read in place by both
paths; a heap array is passed as an array region (JNI) or copied once into native memory
(FFM). Only the problem's first raster travels by pointer; further pixel rasters are
embedded as base64. Do not modify the buffer while a solve runs.

## Results

`LabelAnything.place(..)` returns a `LabelResult` record: `placements()` (one
`LabelPlacement` per item, in input order: `id`, `placed`, `box`, `anchor` (the item's
point; passed back with `warmStart(result)` the boxes move with it), `anchorSide`, `model`,
`leader` with its polyline `points()`, `fanLeaders`, `lines`, `reason`, `members`,
`degradeSteps`, `blocking`, `blockedBy`, `priority`, and the complete JSON object as
`raw()`), `omissionOrder()`, `stats()` (a `Stats` record plus `raw()`), `warnings()`,
`debugSvg()` and `json()` (the result text). `LabelResult.parse(json)` reads results
written elsewhere (e.g. by the CLI).

Other entry points: `place(String json)` (raw problem JSON), `placeJson(String)` (JSON
out), `place(String json, Raster pixels)` (raw JSON plus pixels by pointer; the JSON's
first raster object supplies the options), `validate(problem or json)` (a
`ValidationReport` with errors and warnings, never throws for invalid problems),
`renderSvg(problem, result)`, `version()` and `backend()` (`"ffm"` or `"jni"`).

Invalid problems throw `LabelAnythingException` with `code()` `INVALID` and one
`Issue(pointer, code, message)` per error, e.g. `/items/0/anchor/y [required] ...`. Other
failures (library not found, internal errors) have `code()` `ERROR`.

All methods are thread-safe; solves run in parallel on the calling threads.

## Native library lookup

`liblabelanything` (built with the cargo feature `jni`, so one file serves both paths) is
loaded from, in order:

1. the system property `labelanything.library.path` (the file or its directory);
2. the directories of `java.library.path`;
3. the JAR resource `native/{os}-{arch}/{file}`, extracted to a temporary directory
   (`labelanything.library.tmpdir`, else `java.io.tmpdir`). `{os}` is `linux`, `macos` or
   `windows`, `{arch}` `x86_64` or `aarch64`, `{file}` `liblabelanything.so`,
   `liblabelanything.dylib` or `labelanything.dll`.

The Maven build bundles the library of the building platform (property
`labelanything.native.dir`, default `rust/target/release`); a release JAR collects the
libraries of every platform under `native/`.

`-Dlabelanything.backend=ffm|jni|auto` overrides the path choice (`auto`: FFM on Java 22+,
falling back to JNI if FFM cannot be initialized).

## Limitations

* The JAR built here bundles only the library of the build platform (linux-x86_64 in CI).
* Raw pixels are copied once by the native library (as for every host); file and
  encoded-image backgrounds are decoded by the native library.
* Relative file paths in raw JSON (`obstacles.raster.source`, `obstacles.svg.path`,
  `font.file`) resolve against the process working directory; the builder sends absolute
  paths.
* No host text measurement or cost callbacks across the boundary: measure text in Java and
  pass `Label.text(..).size(w, h).lines(..)` instead.
