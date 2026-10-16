package io.github.fabianbeck.labelanything;

/** How a raster background becomes obstacles (spec §4.6). */
public enum RasterMode implements JsonName {
  /** Pixels that differ from the background colour are {@code ink} (default). */
  INK,
  /** Pixels above an alpha threshold are obstacles. */
  ALPHA,
  /** Darkness (or brightness, with {@code invert}) is a soft cost. */
  COST,
  /** Colours map to obstacle classes. */
  CLASSMAP,
  /** Visual saliency is a soft cost. */
  SALIENCY;

  @Override
  public String jsonName() {
    return JsonName.lower(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static RasterMode fromJson(String json) {
    return JsonName.parse(RasterMode.class, json);
  }
}
