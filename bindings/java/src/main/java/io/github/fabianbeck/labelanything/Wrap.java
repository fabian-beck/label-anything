package io.github.fabianbeck.labelanything;

import java.util.Map;

/**
 * Text wrapping settings (spec §5.3).
 *
 * <pre>{@code Wrap.width(80).maxLines(2).balance()}</pre>
 */
public final class Wrap extends Spec {
  private Wrap(Map<String, Object> json) {
    super(json);
  }

  /** Wrap at a maximum line width in px. */
  public static Wrap width(double maxWidthPx) {
    return new Wrap(Map.of()).maxWidth(maxWidthPx);
  }

  /** Wrap at a maximum line width with a unit, e.g. {@code "8em"}. */
  public static Wrap width(String maxWidth) {
    return new Wrap(Map.of()).maxWidth(maxWidth);
  }

  /** Wrap into at most {@code maxLines} lines (no width limit). */
  public static Wrap lines(int maxLines) {
    return new Wrap(Map.of()).maxLines(maxLines);
  }

  private Wrap with(String key, Object value) {
    return new Wrap(Spec.with(json, key, value));
  }

  /** Maximum line width in px. */
  public Wrap maxWidth(double px) {
    return with("max_width", len(px));
  }

  /** Maximum line width with a unit ({@code px}, {@code pt}, {@code em}). */
  public Wrap maxWidth(String length) {
    return with("max_width", len(length));
  }

  /** Maximum number of lines (&ge; 1). */
  public Wrap maxLines(int maxLines) {
    return with("max_lines", maxLines);
  }

  /** Balance line lengths. */
  public Wrap balance() {
    return with("balance", true);
  }

  /** Balance line lengths or not. */
  public Wrap balance(boolean balance) {
    return with("balance", balance);
  }
}
