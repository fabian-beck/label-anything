package io.github.fabianbeck.labelanything;

/**
 * Access to {@code liblabelanything}: FFM (Java 22+, the C ABI through {@code
 * Linker.nativeLinker()}) or JNI (Java 17+, the exports of the {@code jni} cargo feature).
 * Both call the same Rust implementation, so they return identical text.
 */
interface NativeBackend {
  /** Return code: success. */
  int OK = 0;

  /** {@code "ffm"} or {@code "jni"}. */
  String name();

  /** The native library version. */
  String version();

  /** {@code la_place_json}; {@code pixels} may be null. */
  Reply place(String problem, Pixels pixels);

  /** {@code la_validate_json}. */
  Reply validate(String problem);

  /** {@code la_render_svg}. */
  Reply renderSvg(String problem, String result);

  /** A return code ({@code LA_OK}, {@code LA_INVALID}, {@code LA_ERROR}) and the returned text. */
  record Reply(int code, String text) {}
}
