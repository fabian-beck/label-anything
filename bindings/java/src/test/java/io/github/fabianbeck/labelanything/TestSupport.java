package io.github.fabianbeck.labelanything;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.fail;

import io.github.fabianbeck.labelanything.json.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/** Shared helpers of the tests. */
final class TestSupport {
  private TestSupport() {}

  /** {@code conformance/problems} of the repository. */
  static Path problemsDir() {
    String p = System.getProperty("labelanything.conformance.dir");
    if (p != null && !p.isBlank()) {
      return Paths.get(p);
    }
    Path d = Paths.get("").toAbsolutePath();
    while (d != null) {
      Path c = d.resolve("conformance/problems");
      if (Files.isDirectory(c)) {
        return c;
      }
      d = d.getParent();
    }
    throw new IllegalStateException("conformance/problems not found; set -Dlabelanything.conformance.dir");
  }

  /** File names of all conformance problems, sorted. */
  static Stream<String> problemNames() {
    try (Stream<Path> s = Files.list(problemsDir())) {
      return s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".json")).sorted()
          .toList().stream();
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  static String problem(String name) {
    try {
      return Files.readString(problemsDir().resolve(name), UTF_8);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  /** The inline problem of a {@code conformance/place} case. */
  static Object placeCaseProblem(String name) {
    try {
      Path f = problemsDir().resolveSibling("place").resolve(name);
      return Json.parseObject(Files.readString(f, UTF_8)).get("problem");
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  /** The problem with {@code solver.strategy = "greedy"} (other options kept). */
  @SuppressWarnings("unchecked")
  static String greedy(String problemJson) {
    Map<String, Object> p = Json.parseObject(problemJson);
    Object s = p.get("solver");
    Map<String, Object> solver = s instanceof Map ? (Map<String, Object>) s : new LinkedHashMap<>();
    solver.put("strategy", "greedy");
    p.put("solver", solver);
    return Json.write(p);
  }

  /**
   * A result without its wall-clock fields: {@code stats.runtime_ms}, {@code
   * stats.phases_ms} and the runtime printed in the debug SVG's footer.
   */
  @SuppressWarnings("unchecked")
  static Map<String, Object> normalized(String resultJson) {
    Map<String, Object> r = Json.parseObject(resultJson);
    Object stats = r.get("stats");
    if (stats instanceof Map) {
      ((Map<String, Object>) stats).remove("runtime_ms");
      ((Map<String, Object>) stats).remove("phases_ms");
    }
    if (r.get("debug_svg") instanceof String svg) {
      r.put("debug_svg", svg.replaceAll("· [0-9.]+ ms<", "· # ms<"));
    }
    return r;
  }

  /** Assert two results are equal except for wall-clock fields. */
  static void assertSameResult(String expectedJson, String actualJson, String what) {
    Map<String, Object> a = normalized(expectedJson);
    Map<String, Object> b = normalized(actualJson);
    if (!Json.equalValues(a, b)) {
      fail(what + ": results differ at " + firstDifference(a, b, ""));
    }
  }

  /** Assert two JSON texts are structurally equal (numbers by value). */
  static void assertSameJson(String expectedJson, String actualJson) {
    Object a = Json.parse(expectedJson);
    Object b = Json.parse(actualJson);
    if (!Json.equalValues(a, b)) {
      fail("JSON differs at " + firstDifference(a, b, "") + "\nexpected: " + Json.write(a)
          + "\nactual:   " + Json.write(b));
    }
  }

  /** JSON pointer of the first difference, with both values. */
  static String firstDifference(Object a, Object b, String at) {
    if (a instanceof Map<?, ?> x && b instanceof Map<?, ?> y) {
      for (Object k : x.keySet()) {
        if (!y.containsKey(k)) {
          return at + "/" + k + " (missing in actual)";
        }
        if (!Json.equalValues(x.get(k), y.get(k))) {
          return firstDifference(x.get(k), y.get(k), at + "/" + k);
        }
      }
      for (Object k : y.keySet()) {
        if (!x.containsKey(k)) {
          return at + "/" + k + " (unexpected in actual)";
        }
      }
    } else if (a instanceof List<?> x && b instanceof List<?> y) {
      for (int i = 0; i < Math.min(x.size(), y.size()); i++) {
        if (!Json.equalValues(x.get(i), y.get(i))) {
          return firstDifference(x.get(i), y.get(i), at + "/" + i);
        }
      }
      return at + " (length " + x.size() + " vs " + y.size() + ")";
    }
    String sa = String.valueOf(a);
    String sb = String.valueOf(b);
    return at + ": " + (sa.length() > 200 ? sa.substring(0, 200) + "..." : sa) + " vs "
        + (sb.length() > 200 ? sb.substring(0, 200) + "..." : sb);
  }

  /** The Rust CLI binary, or null when not built. */
  static Path cli() {
    String p = System.getProperty("labelanything.cli");
    if (p == null || p.isBlank()) {
      return null;
    }
    Path path = Paths.get(p);
    return Files.isExecutable(path) ? path : null;
  }

  /** {@code label-anything place -} with the problem on stdin; returns stdout. */
  static String runCli(Path cli, String problemJson) throws IOException, InterruptedException {
    Process proc = new ProcessBuilder(List.of(cli.toString(), "place", "-"))
        .redirectError(ProcessBuilder.Redirect.INHERIT)
        .start();
    Thread writer = new Thread(() -> {
      try (OutputStream in = proc.getOutputStream()) {
        in.write(problemJson.getBytes(UTF_8));
      } catch (IOException ignored) {
        // the process failed; reported below
      }
    });
    writer.start();
    byte[] out;
    try (InputStream stdout = proc.getInputStream()) {
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      stdout.transferTo(buf);
      out = buf.toByteArray();
    }
    writer.join();
    if (!proc.waitFor(120, TimeUnit.SECONDS)) {
      proc.destroyForcibly();
      throw new IOException("CLI timed out");
    }
    if (proc.exitValue() != 0) {
      throw new IOException("CLI exited with " + proc.exitValue());
    }
    return new String(out, UTF_8).trim();
  }

  /** The requested backend name of this test run ({@code ffm}, {@code jni} or null). */
  static String requestedBackend() {
    String b = System.getProperty("labelanything.backend");
    return b == null || b.isBlank() || b.equals("auto") ? null : b;
  }

  /** Every backend this JVM can use: JNI, plus FFM on Java 22+. */
  static List<NativeBackend> allBackends() {
    List<NativeBackend> out = new ArrayList<>();
    if (Backends.ffmSupported()) {
      out.add(Backends.ffm());
    }
    out.add(Backends.jni());
    return out;
  }

  /** A white RGBA image with a black rectangle. */
  static byte[] imageWithBlock(int w, int h, int bx, int by, int bw, int bh) {
    byte[] rgba = new byte[w * h * 4];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int i = (y * w + x) * 4;
        boolean ink = x >= bx && x < bx + bw && y >= by && y < by + bh;
        byte v = (byte) (ink ? 0 : 255);
        rgba[i] = v;
        rgba[i + 1] = v;
        rgba[i + 2] = v;
        rgba[i + 3] = (byte) 255;
      }
    }
    return rgba;
  }
}
