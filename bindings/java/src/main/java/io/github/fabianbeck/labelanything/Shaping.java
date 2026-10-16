package io.github.fabianbeck.labelanything;

/** Text shaping mode. */
public enum Shaping implements JsonName {
  /** Simple unless the text needs complex shaping (default). */
  AUTO,
  /** cmap + hmtx + pair kerning, identical in every implementation. */
  SIMPLE,
  /** HarfBuzz-compatible shaping. */
  FULL;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Shaping fromJson(String json) {
    return JsonName.parse(Shaping.class, json);
  }
}
