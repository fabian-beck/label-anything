package io.github.fabianbeck.labelanything;

/** Tie-breaking rule of the priority order (spec §9.1). */
public enum Ties implements JsonName {
  /** Lower input index first (default). */
  INPUT_ORDER,
  /** Code-point order of ids. */
  ID,
  /** Smaller anchor x first. */
  ANCHOR_X,
  /** A PCG32 permutation seeded with solver.seed. */
  RANDOM;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Ties fromJson(String json) {
    return JsonName.parse(Ties.class, json);
  }
}
