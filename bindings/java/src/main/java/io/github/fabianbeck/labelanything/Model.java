package io.github.fabianbeck.labelanything;

/** Candidate models (spec §6), also reported per placed label. */
public enum Model implements JsonName {
  /** Eight fixed positions touching the mark. */
  ADJACENT,
  /** Positions sliding along the mark. */
  SLIDER,
  /** Inside the mark (or area). */
  INTERNAL,
  /** Farther away, with a leader. */
  DISTANT,
  /** In the canvas margins, with a leader. */
  BOUNDARY,
  /**
   * In a column beside a crowd of items, with a leader ({@link Placement#fan}); reported
   * only, not a model to list in {@link Placement#models}.
   */
  FAN;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Model fromJson(String json) {
    return JsonName.parse(Model.class, json);
  }
}
