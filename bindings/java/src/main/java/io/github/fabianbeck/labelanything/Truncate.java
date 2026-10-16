package io.github.fabianbeck.labelanything;

/** Truncation of wrapped text that exceeds its line limit. */
public enum Truncate implements JsonName {
  /** No truncation (default). */
  NONE,
  /** Ellipsis at the end. */
  END,
  /** Ellipsis in the middle. */
  MIDDLE;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Truncate fromJson(String json) {
    return JsonName.parse(Truncate.class, json);
  }
}
