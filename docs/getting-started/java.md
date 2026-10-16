# Java

`io.github.fabian-beck:label-anything` is the Java binding of the Rust engine, without
runtime dependencies: a builder emits the problem JSON, the native library solves it, and
the result is parsed into records. Java 22+ calls the C ABI through the Foreign Function &
Memory API; Java 17–21 use JNI. Both paths give identical results. The complete API is in
the [Java API reference](../bindings/java.md).

```xml
<dependency>
  <groupId>io.github.fabian-beck</groupId>
  <artifactId>label-anything</artifactId>
  <version>0.1.0</version>
</dependency>
```

Start the JVM with `--enable-native-access=ALL-UNNAMED` (Java 22+ warns without it;
executable JARs can set `Enable-Native-Access: ALL-UNNAMED` in their manifest). The JAR
bundles `liblabelanything` for its platform and finds it on its own
([lookup order](../bindings/java.md#native-library-lookup)).

## The builder

Every builder method maps to a field of the problem; unset options keep their
[defaults](../reference/defaults.md). Option objects (`Label`, `Mark`, `Leaders`,
`Avoid`, …) are immutable: each fluent call returns a new object. Lengths take a number
(px) or a string with a unit (`"0.5em"`, `"3px"`, `"2pt"`).

```java
--8<-- "examples/tutorials/java/GettingStarted.java:builder"
```

## Results

`LabelAnything.place` returns a `LabelResult` record: one `LabelPlacement` per item in input
order (`id`, `placed`, `box`, `anchorSide`, `model`, `leader`, `lines`, `reason`,
`blockedBy`, …, and the complete JSON object as `raw()`), `omissionOrder()` and `stats()`.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:results"
```

## Errors

Invalid problems throw `LabelAnythingException` (`code()` `INVALID`) with one
`Issue(pointer, code, message)` per error; other failures have `code()` `ERROR`.

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

## Raster pixels without copies

A direct `ByteBuffer` of RGBA8 pixels is read in place by the native library (no base64,
no image decoding); heap arrays are copied once.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:pixels"
```

The [outliers tutorial](../tutorials/outliers.md) has a complete program that reads a CSV
and an image file. All programs on this page are in
[`examples/tutorials/java`](gh:examples/tutorials/java) and run in CI on JDK 25 (FFM) and
JDK 17 (JNI).
