# Java

`io.github.fabian-beck:label-anything` is the Java binding of the Rust engine, without
runtime dependencies: a builder emits the problem JSON, the native library solves it, and
the result is parsed into records. Java 22+ calls the C ABI through the Foreign Function &
Memory API; Java 17–21 use JNI. Both paths give identical results. The complete API is in
the [Java API reference](../bindings/java.md).

## Install

The JAR is not in Maven Central yet: build it from this repository
([install from this repository](index.md#install-from-this-repository)) and install it into
your local Maven repository. Building needs JDK 22+ (for the FFM classes; an enforcer rule
stops older JDKs), Maven 3.9 and Rust ≥ 1.88; the JAR runs on Java 17+.

```sh
# liblabelanything: the C ABI (Java 22+) and the JNI entry points (Java 17–21)
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
bundles `liblabelanything` for the platform it was built on and finds it on its own
([lookup order](../bindings/java.md#native-library-lookup)).

**Java 17–21** run the same JAR through JNI, which needs the library built with
`--features jni`. Without a JDK 22+ to build the JAR, compile the JNI path (the base
classes) with the JDK you have. The result uses JNI on every Java version and does not
bundle the library: point `labelanything.library.path` at it.

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

## Raster pixels by pointer {#raster-pixels-without-copies}

RGBA8 pixels go to the native library by pointer, without encoding them as PNG or base64:
a direct `ByteBuffer` by its address, a heap array after one copy into native memory (FFM)
or as an array region (JNI). The native library copies them into its own image.

```java
--8<-- "examples/tutorials/java/GettingStarted.java:pixels"
```

The [outliers tutorial](../tutorials/outliers.md) has a complete program that reads a CSV
and an image file. All programs on this page are in
[`examples/tutorials/java`](gh:examples/tutorials/java) and run in CI on JDK 25 (FFM) and
JDK 17 (JNI).
