package io.github.fabianbeck.labelanything;

import java.nio.file.Path;
import java.util.Map;

/**
 * An SVG background (spec §4.5): drawn elements become obstacles, classified by CSS
 * selectors (first matching rule wins).
 *
 * <pre>{@code
 * Svg.markup(svgText).classify(".outlier", "outliers").classify("text", "text").defaultClass("ink")
 * }</pre>
 */
public final class Svg extends Spec {
  private Svg(Map<String, Object> json) {
    super(json);
  }

  /** SVG markup. */
  public static Svg markup(String svg) {
    return new Svg(obj("source", svg));
  }

  /** An SVG file, read by the native library. */
  public static Svg file(Path svg) {
    return new Svg(obj("path", svg));
  }

  private Svg with(String key, Object value) {
    return new Svg(Spec.with(json, key, value));
  }

  /** Elements matching {@code selector} produce obstacles of class {@code className}. */
  public Svg classify(String selector, String className) {
    return new Svg(Spec.append(json, "classes", obj("selector", selector, "class", className)));
  }

  /** Elements matching {@code selector} are not obstacles. */
  public Svg ignore(String selector) {
    return classify(selector, "ignore");
  }

  /** Class of drawn elements no rule matches (default {@code ink}; {@code "ignore"} drops them). */
  public Svg defaultClass(String className) {
    return with("default_class", className);
  }

  /** Take item marks from SVG elements with the item's {@code svg_id}. */
  public Svg autoMarkItems() {
    return with("auto_mark_items", true);
  }

  /** Whether to take item marks from SVG elements with the item's {@code svg_id}. */
  public Svg autoMarkItems(boolean enabled) {
    return with("auto_mark_items", enabled);
  }

  /** Curve flattening tolerance in px (default 0.25). */
  public Svg tolerance(double px) {
    return with("tolerance", px);
  }
}
