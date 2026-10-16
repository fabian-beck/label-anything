package io.github.fabianbeck.labelanything;

import java.util.List;

/**
 * Steps of the degradation ladder (spec §5.7, §10.1), tried in order for items that do not
 * fit. Default: alternatives, wrap, distant, boundary, evict_lower, shrink:0.85,
 * soft_overlap, omit.
 */
public final class Degrade implements JsonName {
  /** Shorter alternative texts. */
  public static final Degrade ALTERNATIVES = new Degrade("alternatives");
  /** Wrap into more lines. */
  public static final Degrade WRAP = new Degrade("wrap");
  /** Truncate with an ellipsis. */
  public static final Degrade TRUNCATE = new Degrade("truncate");
  /** Distant positions with leaders. */
  public static final Degrade DISTANT = new Degrade("distant");
  /** Boundary positions in the canvas margins. */
  public static final Degrade BOUNDARY = new Degrade("boundary");
  /** Remove conflicting labels of strictly lower priority. */
  public static final Degrade EVICT_LOWER = new Degrade("evict_lower");
  /** Relax the hard classes of {@code avoid.relaxable} to a soft weight. */
  public static final Degrade SOFT_OVERLAP = new Degrade("soft_overlap");
  /** Give up. */
  public static final Degrade OMIT = new Degrade("omit");

  private final String step;

  private Degrade(String step) {
    this.step = step;
  }

  /** Shrink the font by {@code factor} (0 &lt; factor &le; 1), repeatedly down to min_scale. */
  public static Degrade shrink(double factor) {
    if (!(factor > 0 && factor <= 1)) {
      throw new IllegalArgumentException("shrink factor must be in (0, 1]: " + factor);
    }
    return new Degrade("shrink:" + Spec.plainNumber(factor));
  }

  /** The default ladder. */
  public static List<Degrade> defaults() {
    return List.of(ALTERNATIVES, WRAP, DISTANT, BOUNDARY, EVICT_LOWER, shrink(0.85), SOFT_OVERLAP, OMIT);
  }

  @Override
  public String jsonName() {
    return step;
  }

  @Override
  public String toString() {
    return step;
  }

  @Override
  public boolean equals(Object o) {
    return o instanceof Degrade d && d.step.equals(step);
  }

  @Override
  public int hashCode() {
    return step.hashCode();
  }
}
