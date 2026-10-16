package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.util.List;
import java.util.Objects;

/**
 * Label Anything: a host-independent label placement engine. One problem in, one result
 * out.
 *
 * <pre>{@code
 * LabelResult r = LabelAnything.place(problem);
 * for (LabelPlacement p : r.placements()) {
 *   System.out.println(p.id() + " " + p.placed() + " " + p.box() + " " + p.anchorSide());
 * }
 * }</pre>
 *
 * <p>Calls go to the native library {@code liblabelanything} through FFM on Java 22+ and
 * through JNI on Java 17–21 (or with {@code -Dlabelanything.backend=jni}). All methods are
 * thread-safe. On Java 22+ start the JVM with {@code --enable-native-access=ALL-UNNAMED}
 * to avoid the restricted-method warning.
 */
public final class LabelAnything {
  private LabelAnything() {}

  /**
   * Solve a problem.
   *
   * @throws LabelAnythingException if the problem is invalid (with one {@link Issue} per
   *     error) or the native library fails
   */
  public static LabelResult place(LabelProblem problem) {
    Objects.requireNonNull(problem, "problem");
    return LabelResult.parse(check(Backends.get().place(problem.toJson(), problem.pointerPixels())));
  }

  /** Solve a problem given as JSON text (problem.v1). */
  public static LabelResult place(String problemJson) {
    return LabelResult.parse(placeJson(problemJson));
  }

  /**
   * Solve a problem given as JSON text with a raw-pixel raster background passed by
   * pointer; the problem's first {@code obstacles.raster} object (if any) supplies the
   * options (mode, class, scale, ...), as in the C ABI.
   */
  public static LabelResult place(String problemJson, Raster pixels) {
    Objects.requireNonNull(problemJson, "problemJson");
    if (!pixels.isPixels()) {
      throw new IllegalArgumentException("expected a Raster.pixels(...) or Raster.argb(...) raster");
    }
    return LabelResult.parse(check(Backends.get().place(problemJson, pixels.pixels)));
  }

  /** Solve a problem given as JSON text and return the result JSON text. */
  public static String placeJson(String problemJson) {
    Objects.requireNonNull(problemJson, "problemJson");
    return check(Backends.get().place(problemJson, null));
  }

  /** Validate a problem (never throws for invalid problems: see {@link ValidationReport}). */
  public static ValidationReport validate(LabelProblem problem) {
    return validate(problem.toJson());
  }

  /** Validate a problem given as JSON text. */
  public static ValidationReport validate(String problemJson) {
    Objects.requireNonNull(problemJson, "problemJson");
    NativeBackend.Reply r = Backends.get().validate(problemJson);
    return ValidationReport.parse(r.text());
  }

  /** The debug SVG overlay of a problem and its result. */
  public static String renderSvg(LabelProblem problem, LabelResult result) {
    return renderSvg(problem.toPortableJson(), result.json());
  }

  /** The debug SVG overlay of a problem and a result given as JSON text. */
  public static String renderSvg(String problemJson, String resultJson) {
    Objects.requireNonNull(problemJson, "problemJson");
    Objects.requireNonNull(resultJson, "resultJson");
    return check(Backends.get().renderSvg(problemJson, resultJson));
  }

  /** The native library version, e.g. {@code 0.1.0}. */
  public static String version() {
    return Backends.get().version();
  }

  /** The native backend in use: {@code "ffm"} or {@code "jni"}. */
  public static String backend() {
    return Backends.get().name();
  }

  private static String check(NativeBackend.Reply r) {
    if (r.code() == NativeBackend.OK) {
      return r.text();
    }
    List<Issue> issues;
    try {
      issues = Issue.listFromJson(Json.parse(r.text()));
    } catch (IllegalArgumentException notJson) {
      issues = List.of(new Issue("", "internal", r.text()));
    }
    throw new LabelAnythingException(
        r.code() == LabelAnythingException.INVALID ? LabelAnythingException.INVALID
            : LabelAnythingException.ERROR,
        issues);
  }
}
