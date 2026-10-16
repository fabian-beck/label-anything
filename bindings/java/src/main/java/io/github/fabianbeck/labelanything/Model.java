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
  BOUNDARY;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Model fromJson(String json) {
    return JsonName.parse(Model.class, json);
  }
}
