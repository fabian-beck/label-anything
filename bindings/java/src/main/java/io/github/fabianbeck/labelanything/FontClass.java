package io.github.fabianbeck.labelanything;

import java.math.BigDecimal;
import java.util.Map;

/**
 * A font class: type size by importance (spec §9.4). Classes take consecutive stretches of
 * the total priority order, most important first; each ends where its {@code first} says
 * (cumulative), the last may take the rest.
 *
 * <pre>{@code
 * builder.fontClasses(FontClass.share(5, 1.3).bold(), FontClass.share(25, 1.1), FontClass.rest(0.9))
 * }</pre>
 */
public final class FontClass extends Spec {
  private FontClass(Map<String, Object> json) {
    super(json);
  }

  /** The items up to the first {@code count} of the priority order: text scaled by {@code scale}. */
  public static FontClass first(int count, double scale) {
    return new FontClass(Spec.obj("first", count, "scale", scale));
  }

  /** The items up to {@code percent} % of all items: text scaled by {@code scale}. */
  public static FontClass share(double percent, double scale) {
    String p = BigDecimal.valueOf(percent).stripTrailingZeros().toPlainString();
    return new FontClass(Spec.obj("first", p + "%", "scale", scale));
  }

  /** All the remaining items: text scaled by {@code scale}. */
  public static FontClass rest(double scale) {
    return new FontClass(Spec.obj("scale", scale));
  }

  private FontClass with(String key, Object value) {
    return new FontClass(Spec.with(json, key, value));
  }

  /** Font weight of the class's labels (1–1000; 400 normal, 700 bold). */
  public FontClass weight(int weight) {
    return with("weight", weight);
  }

  /** Bold labels. */
  public FontClass bold() {
    return with("weight", "bold");
  }
}
