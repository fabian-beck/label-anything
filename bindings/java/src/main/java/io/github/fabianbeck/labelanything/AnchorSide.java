package io.github.fabianbeck.labelanything;

/** Where a placed label sits relative to its anchor. */
public enum AnchorSide implements JsonName {
  TOP,
  RIGHT,
  BOTTOM,
  LEFT,
  TOP_RIGHT,
  BOTTOM_RIGHT,
  TOP_LEFT,
  BOTTOM_LEFT,
  INTERNAL,
  DISTANT,
  BOUNDARY,
  FAN;

  @Override
  public String jsonName() {
    return JsonName.hyphen(this);
  }

  /** The constant spelled {@code json} in JSON ({@code null} if unknown). */
  public static AnchorSide fromJson(String json) {
    return JsonName.parse(AnchorSide.class, json);
  }
}
