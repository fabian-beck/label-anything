package io.github.fabianbeck.labelanything;

import java.nio.ByteBuffer;

/**
 * JNI entry points exported by {@code liblabelanything} when built with the cargo feature
 * {@code jni} ({@code rust/crates/la-capi/src/jni.rs}). Text is UTF-8; every reply but
 * {@link #version()} is {@code [code, utf8...]}.
 */
final class JniNative {
  private JniNative() {}

  /** The library version. */
  static native byte[] version();

  /**
   * {@code la_place_json}: with {@code width > 0 && height > 0} the raster is read from
   * {@code rgbaDirect} (a direct buffer, in place) or else from {@code rgbaArray} at {@code
   * rgbaOffset}.
   */
  static native byte[] placeJson(
      byte[] problem, ByteBuffer rgbaDirect, byte[] rgbaArray, int rgbaOffset, int width, int height);

  /** {@code la_validate_json}. */
  static native byte[] validateJson(byte[] problem);

  /** {@code la_render_svg}. */
  static native byte[] renderSvg(byte[] problem, byte[] result);
}
