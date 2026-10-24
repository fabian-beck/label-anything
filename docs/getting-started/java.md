# Java

`io.github.fabian-beck:label-anything` is the Java binding of the Rust engine, without
runtime dependencies: a builder emits the problem JSON, the native library
`liblabelanything` solves it, and the result is parsed into records. Java 22+ calls the
library through the Foreign Function & Memory API, Java 17–21 through JNI; the JAR is a
multi-release JAR with both, and they give identical results.

## Install

The JAR is not in Maven Central yet: build it in a clone of the repository and install it
into your local Maven repository. Building needs JDK 22+ (for the FFM classes), Maven 3.9
and Rust ≥ 1.88; the JAR runs on Java 17+.

```sh
# liblabelanything with the C ABI (Java 22+) and the JNI entry points (Java 17–21)
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi --features jni
# the JAR, with the library bundled: bindings/java/target/ and ~/.m2/repository
mvn -f bindings/java/pom.xml install
```

`install` runs the unit tests, then the integration tests against the packaged JAR, once
with FFM and once with JNI; `-DskipITs` skips the integration tests, `-DskipTests` all
tests. Then your Maven projects can depend on it:

```xml
<dependency>
  <groupId>io.github.fabian-beck</groupId>
  <artifactId>label-anything</artifactId>
  <version>0.1.0</version>
</dependency>
```

Start the JVM with `--enable-native-access=ALL-UNNAMED` (Java 22+ warns without it;
executable JARs can set `Enable-Native-Access: ALL-UNNAMED` in their manifest). The JAR
bundles `liblabelanything` for the platform it was built on and
[finds it](#the-native-library) on its own.

**Without a JDK 22+**, compile the JNI path (the base classes) with the JDK you have. That
JAR uses JNI on every Java version and does not bundle the library: point
`labelanything.library.path` at it.

```sh
javac --release 17 -d bindings/java/target/jni-classes $(find bindings/java/src/main/java -name '*.java')
jar --create --file bindings/java/target/label-anything-0.1.0-jni.jar -C bindings/java/target/jni-classes .
java -Dlabelanything.library.path=rust/target/release \
     -cp bindings/java/target/label-anything-0.1.0-jni.jar MyApp.java
# Maven projects: install that JAR under the coordinates above
mvn install:install-file -Dfile=bindings/java/target/label-anything-0.1.0-jni.jar \
    -DgroupId=io.github.fabian-beck -DartifactId=label-anything -Dversion=0.1.0 -Dpackaging=jar
```

## The builder

Every builder method sets a field of the [problem](../concepts/problem.md); unset options
keep their [defaults](../reference/defaults.md). Option objects (`Label`, `Mark`,
`Leaders`, `Avoid`, …) are immutable: each fluent call returns a new object. Lengths take a
number (px) or a string with a unit (`"0.5em"`, `"3px"`, `"2pt"`).

```java
--8<-- "examples/tutorials/java/GettingStarted.java:builder"
```

| Builder | Problem field |
|---|---|
| `canvas(w, h)`, `canvasPadding`, `allowOutside`, `region`, `canvasBackground`, `devicePixelRatio`, `yAxisUp()`, `transform(a..f)`, `preset(Preset)` | `canvas`, `y_axis`, `transform`, `preset` |
| `fontSize`, `font(Font.of("default").size(14).bold().lineHeight(1.3))`, `labelPadding`, `buffer`, `margin`, `defaultMark(Mark)`, `wrap(Wrap)`, `truncate(Truncate)`, `textShaping` | `defaults`, `text.shaping` |
| `item(id, x, y, label)`, `item(id, x, y, label, it -> it.mark(..).attr(..))`, `item(Item.point(..)...)`, `area(id, polygon, label)`, `items(...)` | `items` |
| `backgroundRaster(Path or byte[], RasterMode)`, `backgroundPixels(w, h, ByteBuffer or byte[], mode)`, `backgroundSvg(String or Path)`, `background(Raster... or Svg...)`, `vector(VectorLayer)` | `obstacles` |
| `avoid(Avoid.label().hard(..).weight(..), Avoid.leader()..., Avoid.buffer()..., Avoid.relaxable(..))` | `avoid` (merged key by key) |
| `leaders(Leaders.straight()/angles(..)/orthogonal()/elbow(..)/curved().port(..).clearance(..))` | `leaders` |
| `placement(Placement.models(Model...).maxDistance("10em").boundarySides(..))` | `placement` |
| `priority(Priority)`, `tier(where, tier)`, `omission(Omission)`, `coverage(by, n)`, `ties`, `tiesRandom(seed)`, `band`, `maxLabels`, `maxInkFraction`, `focus`, `fontClasses(FontClass...)` | `priority` |
| `timeBudgetMs`, `seed`, `strategy(Strategy)`, `maxIterations`, `gridCell` | `solver` |
| `degrade(Degrade.ALTERNATIVES, Degrade.shrink(0.85), ...)`, `minScale`, `wrapMaxLines`, `softOverlapWeight` | `degrade`, `degrade_options` |
| `weights(Weights.defaults().position(1))`, `warmStart(previousResult)` | `weights`, `warm_start` |
| `debugSvg`, `costBreakdown`, `reportCandidates`, `itemShape` | `output` |
| `option("placement.k_distant", 12)` | any field, by its dotted path |

Items are `Item.point(id, x, y)` or `Item.area(id, polygon)` with a `label`, `mark`
(`Mark.circle/ellipse/rect/polygon/path/icon/fromSvg`), `attr`/`attrs`, `priority`, `tier`,
`required`, `group`, `keepWith(set)`, `keepWithItems(ids...)`, `svgId` and `placement`.
Labels are `Label.text(..)` (with `alternatives`, `wrap`, `truncate`, `font`, `fontSize`,
`padding`, `size`/`lines` for text measured by the host, `align`), `Label.icon(w, h)`,
`Label.box(w, h)` (`rect()`, `circle()`, `rounded(r)`, `polygon(..)`) and
`Label.composite(parts...)` (`row()`, `column()`, `gap`, `align`).

`problem.toJson()` is the JSON sent to the engine; `problem.toPortableJson()` is the same,
self-contained (raw pixels embedded), e.g. for `label-anything place`.

**Priority** is a weighted sum of terms that the engine evaluates
([priority terms](../tutorials/priority.md#priority-terms)): `attr(name)`,
`expr("attrs.cbo * 2")`, `outlierness(k)`, `isolation()`, `crowding()`, `labelSize()`,
`markSize()`, `centrality()`, `degree()` and `inputOrder()`. A term takes a transform
(`log1p()`, `sqrt()`, `neg()`, `abs()`), `normalize(..)`, `weight(w)` and `k(n)`; terms
combine with `plus`, `minus` and `times`:

```java
Priority.attr("cbo").log1p().normalize(Priority.Normalize.MINMAX).times(0.5)
    .plus(Priority.outlierness(5)).minus(Priority.labelSize().times(0.2))
```

`Priority.callback(item -> ...)` computes the score in Java instead: it runs once per item
when the problem is built and writes an explicit `priority` into every item that has none.

## Results

`LabelAnything.place` returns a `LabelResult` record: one `LabelPlacement` per item in
input order, `omissionOrder()` and `stats()`.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:results"
```

A `LabelPlacement` has the fields of the [result format](../concepts/result.md): `id`,
`placed`, `box`, `anchor`, `anchorSide`, `model`, `leader` (with its polyline `points()`),
`fanLeaders`, `lines`, `priority`, `degradeSteps`; for omitted items `reason`, `blocking`
and `blockedBy`; `members` of group labels; and the complete JSON object as `raw()`.
`LabelResult` also has `warnings()`, `debugSvg()` and `json()` (the result text);
`LabelResult.parse(json)` reads results written elsewhere, e.g. by the CLI.

## Errors

Invalid problems throw `LabelAnythingException` (`code()` `INVALID`) with one
`Issue(pointer, code, message)` per error ([codes](../concepts/errors.md)); other failures
(the library not found, internal errors) have `code()` `ERROR`.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:errors"
```

```text
/canvas/width [range] must be > 0
/items/0/label/padding [unit] invalid length "3qq": use a number (px) or <number>px|pt|em
```

## Raw JSON

Problems written elsewhere go in as text; `validate` never throws for invalid problems.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:raw"
```

Further entry points: `place(String json, Raster pixels)` (raw JSON plus pixels by
pointer; the JSON's first raster object supplies the options), `renderSvg(problem,
result)`, `version()` and `backend()` (`"ffm"` or `"jni"`). All methods are thread-safe;
solves run in parallel on the calling threads.

## Raster pixels by pointer {#raster-pixels-without-copies}

`backgroundPixels(width, height, buffer, mode)` (or `Raster.pixels(..)`, `Raster.argb(..)`)
passes row-major RGBA8 pixels (straight alpha) to the native library by pointer, without
encoding them as PNG or base64: a direct `ByteBuffer` by its address, a heap array as an
array region (JNI) or after one copy into native memory (FFM). The library copies them into
its own image. Only the problem's first raster travels by pointer; further pixel rasters are
embedded as base64. Do not modify the buffer while a solve runs.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:pixels"
```

## The native library

`liblabelanything` (built with the cargo feature `jni`, so one file serves both paths) is
loaded from, in order:

1. the system property `labelanything.library.path` (the file or its directory);
2. the directories of `java.library.path`;
3. the JAR resource `native/{os}-{arch}/{file}`, extracted to a temporary directory
   (`labelanything.library.tmpdir`, else `java.io.tmpdir`). `{os}` is `linux`, `macos` or
   `windows`, `{arch}` `x86_64` or `aarch64`, `{file}` `liblabelanything.so`,
   `liblabelanything.dylib` or `labelanything.dll`.

The Maven build bundles the library of the platform it runs on (property
`labelanything.native.dir`, default `rust/target/release`). `-Dlabelanything.backend=ffm`,
`jni` or `auto` overrides the choice of path (`auto`: FFM on Java 22+, falling back to JNI).

## Limitations

* No text measurement or cost callbacks across the boundary: measure text in Java and pass
  `Label.text(..).size(w, h).lines(..)`.
* Relative file paths in raw JSON (`obstacles.raster.source`, `obstacles.svg.path`,
  `font.file`) resolve against the working directory of the process; the builder sends
  absolute paths.

The [outliers tutorial](../tutorials/outliers.md) has a complete program that reads a CSV
and an image file. All programs on this page are in
[`examples/tutorials/java`](gh:examples/tutorials/java) and run in CI on JDK 25 (FFM) and
JDK 17 (JNI).
