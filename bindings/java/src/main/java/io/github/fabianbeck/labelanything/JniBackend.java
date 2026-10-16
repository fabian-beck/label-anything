package io.github.fabianbeck.labelanything;

import static java.nio.charset.StandardCharsets.UTF_8;

import java.nio.file.Path;

/** The JNI path (Java 17+): {@link JniNative} backed by {@code liblabelanything}. */
final class JniBackend implements NativeBackend {
  JniBackend(Path library) {
    System.load(library.toString());
    if (JniNative.version() == null) {
      throw new IllegalStateException("JNI entry points of " + library + " do not answer");
    }
  }

  @Override
  public String name() {
    return "jni";
  }

  @Override
  public String version() {
    return new String(JniNative.version(), UTF_8);
  }

  private static Reply reply(byte[] r) {
    if (r == null || r.length == 0) {
      throw new LabelAnythingException(
          LabelAnythingException.ERROR, java.util.List.of(new Issue("", "native", "empty reply")));
    }
    return new Reply(r[0], new String(r, 1, r.length - 1, UTF_8));
  }

  @Override
  public Reply place(String problem, Pixels px) {
    byte[] p = problem.getBytes(UTF_8);
    if (px == null) {
      return reply(JniNative.placeJson(p, null, null, 0, 0, 0));
    }
    return reply(JniNative.placeJson(p, px.direct, px.array, px.offset, px.width, px.height));
  }

  @Override
  public Reply validate(String problem) {
    return reply(JniNative.validateJson(problem.getBytes(UTF_8)));
  }

  @Override
  public Reply renderSvg(String problem, String result) {
    return reply(JniNative.renderSvg(problem.getBytes(UTF_8), result.getBytes(UTF_8)));
  }
}
