package io.github.fabianbeck.labelanything;

import java.util.Map;

/** Cost weights of the placement objective (spec §8); unset weights keep their defaults. */
public final class Weights extends Spec {
  private Weights(Map<String, Object> json) {
    super(json);
  }

  /** No changes to the default weights. */
  public static Weights defaults() {
    return new Weights(Map.of());
  }

  private Weights with(String key, double value) {
    return new Weights(Spec.with(json, key, value));
  }

  /** × position rank / number of positions (default 0.6). */
  public Weights position(double w) {
    return with("position", w);
  }

  /** × gap between label and own shape in em (default 0.3). */
  public Weights distance(double w) {
    return with("distance", w);
  }

  /** Fixed cost of a leader (default 1.0). */
  public Weights leader(double w) {
    return with("leader", w);
  }

  /** × leader length in em (default 0.25). */
  public Weights leaderLength(double w) {
    return with("leader_length", w);
  }

  /** × number of leader bends (default 0.3). */
  public Weights bends(double w) {
    return with("bends", w);
  }

  /** × shape penalty: wrap, alternative, truncate, shrink, relaxed overlap (default 0.5). */
  public Weights shape(double w) {
    return with("shape", w);
  }

  /** × proximity to the canvas edge (default 0.2). */
  public Weights edge(double w) {
    return with("edge", w);
  }

  /** Label closer to another item than to its own (default 1.0). */
  public Weights ambiguity(double w) {
    return with("ambiguity", w);
  }

  /** Greedy look-ahead (default 0.3). */
  public Weights lookahead(double w) {
    return with("lookahead", w);
  }

  /** Items whose last candidates would be invalidated (default 2.0). */
  public Weights starve(double w) {
    return with("starve", w);
  }

  /**
   * × 4 · luma variance of the raster backdrop under the label, per em² (default 0.5): labels
   * avoid straddling a border between light and dark.
   */
  public Weights contrast(double w) {
    return with("contrast", w);
  }

  /**
   * × the area of the label across region borders, per em² (default 0.5): on a region map
   * (spec §4.8), labels stay inside one region.
   */
  public Weights straddle(double w) {
    return with("straddle", w);
  }

  /** × the label's area in regions other than its item's and open space, per em² (default 0.5). */
  public Weights foreign(double w) {
    return with("foreign", w);
  }

  /** × number of region borders a leader crosses (default 1.0). */
  public Weights leaderBorders(double w) {
    return with("leader_borders", w);
  }

  /** Displacement from the warm start in em (default 1.0). */
  public Weights stability(double w) {
    return with("stability", w);
  }
}
