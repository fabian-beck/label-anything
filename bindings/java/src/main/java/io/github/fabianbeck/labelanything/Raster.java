package io.github.fabianbeck.labelanything;

import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A raster background (spec §4.6): an image file, encoded image bytes (PNG, JPEG, WebP), or
 * raw RGBA pixels. Pixels go to the native library through the pointer entry point (no PNG or
 * base64 encoding) when they are the problem's first raster.
 *
 * <pre>{@code
 * Raster.file(Path.of("map.png")).mode(RasterMode.INK).inkThreshold(0.15)
 * Raster.pixels(width, height, directByteBuffer).mode(RasterMode.ALPHA)
 * }</pre>
 */
public final class Raster extends Spec {
  final Pixels pixels;

  private Raster(Map<String, Object> json, Pixels pixels) {
    super(json);
    this.pixels = pixels;
  }

  /** An image file (PNG, JPEG, WebP), read by the native library. */
  public static Raster file(Path image) {
    return new Raster(obj("source", image), null);
  }

  /** Encoded image bytes (PNG, JPEG, WebP), sent as a {@code data:} URL. */
  public static Raster encoded(byte[] image) {
    return new Raster(obj("source", "data:" + mime(image) + ";base64,"
        + Base64.getEncoder().encodeToString(image)), null);
  }

  /** A {@code source} string as the schema accepts it: data URL, base64 or file path. */
  public static Raster source(String source) {
    return new Raster(obj("source", source), null);
  }

  /**
   * Raw RGBA8 pixels (row-major, straight alpha, {@code width * height * 4} bytes from the
   * buffer's position). A direct buffer is passed to the native library in place. The
   * buffer is not copied: do not modify it while a solve runs.
   */
  public static Raster pixels(int width, int height, ByteBuffer rgba) {
    return new Raster(Map.of(), Pixels.of(width, height, rgba));
  }

  /** Raw RGBA8 pixels in an array (not copied: do not modify it while a solve runs). */
  public static Raster pixels(int width, int height, byte[] rgba) {
    return new Raster(Map.of(), Pixels.of(width, height, rgba));
  }

  /** Packed ARGB pixels ({@code BufferedImage.getRGB(0, 0, w, h, null, 0, w)}). */
  public static Raster argb(int width, int height, int[] argb) {
    return new Raster(Map.of(), Pixels.argb(width, height, argb));
  }

  private static String mime(byte[] b) {
    if (b.length >= 4 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
      return "image/png";
    }
    if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) {
      return "image/jpeg";
    }
    if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[8] == 'W' && b[9] == 'E') {
      return "image/webp";
    }
    return "application/octet-stream";
  }

  /** Whether this raster is raw pixels. */
  public boolean isPixels() {
    return pixels != null;
  }

  private Raster with(String key, Object value) {
    return new Raster(Spec.with(json, key, value), pixels);
  }

  @SuppressWarnings("unchecked")
  private Raster nested(String outer, String key, Object value) {
    Object o = json.get(outer);
    Map<String, Object> inner = o instanceof Map ? (Map<String, Object>) o : Map.of();
    return with(outer, Spec.with(inner, key, value));
  }

  /** How pixels become obstacles (default {@link RasterMode#INK}). */
  public Raster mode(RasterMode mode) {
    return with("mode", mode);
  }

  /** Obstacle class produced by the ink, alpha, cost and saliency modes (default {@code ink}). */
  public Raster obstacleClass(String className) {
    return with("class", className);
  }

  /** Raster pixels per canvas pixel (default 1). */
  public Raster scale(double scale) {
    return with("scale", scale);
  }

  /** Canvas position of the raster's top-left corner. */
  public Raster offset(double x, double y) {
    return with("offset", new double[] {x, y});
  }

  /** Background colour {@code #rrggbb} of the ink mode (default: most frequent border colour). */
  public Raster inkBackground(String color) {
    return nested("ink", "background", color);
  }

  /** OKLab distance above which a pixel is ink (default 0.12). */
  public Raster inkThreshold(double threshold) {
    return nested("ink", "threshold", threshold);
  }

  /** Dilation of the ink coverage in grid cells (default 1). */
  public Raster inkDilate(int cells) {
    return nested("ink", "dilate", cells);
  }

  /** Alpha above which a pixel is an obstacle (alpha mode, default 0.1). */
  public Raster alphaThreshold(double threshold) {
    return nested("alpha", "threshold", threshold);
  }

  /** Cost mode: bright (true) or dark (false, default) is costly. */
  public Raster costInvert(boolean invert) {
    return nested("cost", "invert", invert);
  }

  /** Classmap mode: pixels of {@code color} ({@code #rrggbb}) are of class {@code className}. */
  public Raster classmap(String color, String className) {
    return nested("classmap", color, className);
  }

  /** Max OKLab distance of a classmap match (default 0.08). */
  public Raster classmapTolerance(double tolerance) {
    return with("classmap_tolerance", tolerance);
  }

  /** Class of non-background pixels no classmap colour matches: {@code "ink"} or {@code "ignore"}. */
  public Raster unmatched(String className) {
    return with("unmatched", className);
  }

  /** JSON when the pixels travel through the pointer: options plus a size-only placeholder. */
  Map<String, Object> pointerJson() {
    return withRgba("");
  }

  /** Self-contained JSON: the pixels embedded as base64 {@code rgba}. */
  Map<String, Object> embeddedJson() {
    return pixels == null ? json : withRgba(pixels.base64());
  }

  private Map<String, Object> withRgba(String data) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("rgba", obj("width", pixels.width, "height", pixels.height, "data", data));
    m.putAll(json);
    return java.util.Collections.unmodifiableMap(m);
  }
}
