package io.github.fabianbeck.labelanything;

/** Solver strategy (spec §10). */
public enum Strategy implements JsonName {
  /** Greedy plus local search; exact when small and the budget allows (default). */
  AUTO,
  /** Greedy with the degradation ladder only (fastest; no time-dependent search). */
  GREEDY,
  /** Greedy plus local search. */
  LOCAL,
  /** Exact search for small problems. */
  EXACT;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Strategy fromJson(String json) {
    return JsonName.parse(Strategy.class, json);
  }
}
