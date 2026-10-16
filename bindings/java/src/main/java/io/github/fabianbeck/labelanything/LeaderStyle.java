package io.github.fabianbeck.labelanything;

/** Leader line styles (spec §7). */
public enum LeaderStyle implements JsonName {
  /** One straight segment (default). */
  STRAIGHT,
  /** Straight, restricted to the allowed angles. */
  ANGLES,
  /** Horizontal and vertical segments. */
  ORTHOGONAL,
  /** An angled segment, then horizontal into the label. */
  ELBOW,
  /** A quadratic Bezier curve. */
  CURVED;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static LeaderStyle fromJson(String json) {
    return JsonName.parse(LeaderStyle.class, json);
  }
}
