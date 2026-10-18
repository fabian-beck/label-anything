package io.github.fabianbeck.labelanything;

import java.nio.ByteBuffer;
import java.util.Base64;
import java.util.Objects;

/**
 * Raw RGBA8 pixels (row-major, straight alpha) handed to the native library through the
 * pointer entry point of {@code la_place_json}, without encoding them as PNG or base64: a
 * direct buffer is passed in place; a heap array is passed as a region (JNI) or copied once
 * into native memory (FFM). The native library copies the pixels into its image.
 */
final class Pixels {
  final int width;
  final int height;
  /** Direct buffer covering exactly the pixels, or null. */
  final ByteBuffer direct;
  /** Heap array holding the pixels from {@link #offset}, or null. */
  final byte[] array;

  final int offset;

  private Pixels(int width, int height, ByteBuffer direct, byte[] array, int offset) {
    this.width = width;
    this.height = height;
    this.direct = direct;
    this.array = array;
    this.offset = offset;
  }

  static long byteLength(int width, int height) {
    if (width <= 0 || height <= 0) {
      throw new IllegalArgumentException("raster size must be positive: " + width + "x" + height);
    }
    return (long) width * height * 4;
  }

  /** Pixels in a buffer, from its position (a direct buffer is used in place). */
  static Pixels of(int width, int height, ByteBuffer rgba) {
    Objects.requireNonNull(rgba, "rgba");
    long len = byteLength(width, height);
    if (rgba.remaining() < len) {
      throw new IllegalArgumentException("rgba buffer has " + rgba.remaining() + " bytes, "
          + width + "x" + height + "x4 = " + len + " needed");
    }
    if (rgba.isDirect()) {
      return new Pixels(width, height, rgba.slice(rgba.position(), (int) len), null, 0);
    }
    if (rgba.hasArray()) {
      return new Pixels(width, height, null, rgba.array(), rgba.arrayOffset() + rgba.position());
    }
    byte[] copy = new byte[(int) len];
    rgba.duplicate().get(copy);
    return new Pixels(width, height, null, copy, 0);
  }

  /** Pixels in an array (not copied: do not modify it while a solve runs). */
  static Pixels of(int width, int height, byte[] rgba) {
    Objects.requireNonNull(rgba, "rgba");
    long len = byteLength(width, height);
    if (rgba.length < len) {
      throw new IllegalArgumentException("rgba array has " + rgba.length + " bytes, "
          + width + "x" + height + "x4 = " + len + " needed");
    }
    return new Pixels(width, height, null, rgba, 0);
  }

  /** Packed ARGB ints (as {@code BufferedImage.getRGB} returns them), converted to RGBA. */
  static Pixels argb(int width, int height, int[] argb) {
    Objects.requireNonNull(argb, "argb");
    long n = byteLength(width, height) / 4;
    if (argb.length < n) {
      throw new IllegalArgumentException("argb array has " + argb.length + " pixels, "
          + width + "x" + height + " = " + n + " needed");
    }
    byte[] rgba = new byte[(int) (n * 4)];
    for (int i = 0; i < n; i++) {
      int p = argb[i];
      rgba[4 * i] = (byte) (p >>> 16);
      rgba[4 * i + 1] = (byte) (p >>> 8);
      rgba[4 * i + 2] = (byte) p;
      rgba[4 * i + 3] = (byte) (p >>> 24);
    }
    return new Pixels(width, height, null, rgba, 0);
  }

  int length() {
    return (int) byteLength(width, height);
  }

  /** The pixels as a new array. */
  byte[] toArray() {
    byte[] out = new byte[length()];
    if (direct != null) {
      direct.duplicate().position(0).get(out);
    } else {
      System.arraycopy(array, offset, out, 0, out.length);
    }
    return out;
  }

  /** Base64 of the pixels (for the self-contained {@code rgba} JSON form). */
  String base64() {
    return Base64.getEncoder().encodeToString(toArray());
  }
}
