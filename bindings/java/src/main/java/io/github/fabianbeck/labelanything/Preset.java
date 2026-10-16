package io.github.fabianbeck.labelanything;

/** Bundles of defaults ({@code spec/presets/}). */
public enum Preset implements JsonName {
  /** Adapts to the problem (default). */
  AUTO,
  /** Scatterplots. */
  SCATTER,
  /** Maps. */
  MAP,
  /** Node-link diagrams. */
  GRAPH,
  /** Illustrations with boundary labels. */
  ILLUSTRATION,
  /** No preset: only the built-in defaults. */
  NONE;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static Preset fromJson(String json) {
    return JsonName.parse(Preset.class, json);
  }
}
