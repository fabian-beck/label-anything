package io.github.fabianbeck.labelanything;

/** Omission semantics when not every label fits (spec §9.2). */
public enum Omission implements JsonName {
  /** An omitted label has no feasible position given the placed labels of higher or equal priority (default). */
  STRICT,
  /** The placed set is a prefix of the priority order. */
  PREFIX,
  /** Maximize the summed priority, tiers strict. */
  WEIGHTED;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Omission fromJson(String json) {
    return JsonName.parse(Omission.class, json);
  }
}
