# Label Anything for Java

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

`io.github.fabian-beck:label-anything`: the Java binding of the Label Anything label
placement engine. FFM on Java 22+, JNI on Java 17–21 (one multi-release JAR), no runtime
dependencies. Guide: [Java](https://fabian-beck.github.io/label-anything/getting-started/java/) on the
documentation site ([source](../../docs/getting-started/java.md)).

```java
var problem = LabelProblem.builder()
    .canvas(800, 600).fontSize(12)
    .item("A", 120, 80, Label.text("Alpha"))
    .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
    .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
    .build();
LabelResult r = LabelAnything.place(problem);
```

Build and test (from the repository root; JDK 22+, Maven 3.9, Rust ≥ 1.88):

```sh
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi -p label-anything-cli \
      --features label-anything-capi/jni
mvn -f bindings/java/pom.xml verify      # -Dlabelanything.jni.jvm=<jdk17>/bin/java: JNI tests on Java 17
mvn -f bindings/java/pom.xml install     # also into ~/.m2 for your Maven projects (-DskipITs, -DskipTests)
```

The JAR runs on Java 17+; JNI (Java 17–21) needs the library built with `--features jni`.

| Path | Content |
|---|---|
| `src/main/java` | API, JSON reader/writer, JNI backend (Java 17) |
| `src/main/java22` | FFM backend, compiled into `META-INF/versions/22` |
| `src/test/java` | `*Test`: unit tests (surefire); `*IT`: native tests against the JAR, once per backend (failsafe) |

The JAR bundles `rust/target/release/liblabelanything.so` as
`native/linux-x86_64/liblabelanything.so` (other platforms: `native/{os}-{arch}/`, see the
guide); `-Dlabelanything.library.path=...` loads another build.
