package io.github.fabianbeck.labelanything;

/** Why an item is not labeled (spec §9.3). */
public enum Reason implements JsonName {
  /** Blocked only by labels of higher or equal priority, or cut by prefix/max_labels. */
  OMITTED_BY_PRIORITY,
  /** Every candidate violates a static hard constraint. */
  NO_FEASIBLE_CANDIDATE,
  /** Not reached before the time guard. */
  BUDGET_EXHAUSTED,
  /** A member of its keep-with set failed. */
  KEEP_WITH,
  /** Merged into a group label. */
  GROUPED;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Reason fromJson(String json) {
    return JsonName.parse(Reason.class, json);
  }
}
