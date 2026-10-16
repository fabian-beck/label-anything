package io.github.fabianbeck.labelanything;

import java.util.Arrays;
import java.util.Map;

/**
 * Candidate generation options (spec §6): which models are tried and how.
 *
 * <pre>{@code
 * Placement.models(Model.ADJACENT, Model.SLIDER, Model.DISTANT).maxDistance("10em")
 * Placement.models(Model.BOUNDARY).boundarySides(Placement.Side.LEFT, Placement.Side.RIGHT)
 * }</pre>
 *
 * <p>Per item ({@link Item.Builder#placement}) only the models, offset, internal policy and
 * position order apply.
 */
public final class Placement extends Spec {
  private Placement(Map<String, Object> json) {
    super(json);
  }

  /** The eight adjacent positions. */
  public enum Position implements JsonName {
    TOP,
    RIGHT,
    BOTTOM,
    LEFT,
    TOP_RIGHT,
    BOTTOM_RIGHT,
    TOP_LEFT,
    BOTTOM_LEFT;

    @Override
    public String jsonName() {
      return JsonName.hyphen(this);
    }
  }

  /** Named position orders. */
  public enum PositionOrder implements JsonName {
    /** Top, right, bottom, left, then the diagonals (default). */
    PERCEPTUAL,
    /** Imhof: top-right, top-left, bottom-right, bottom-left, right, left, top, bottom. */
    CARTOGRAPHIC;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** Internal label policy. */
  public enum Internal implements JsonName {
    /** Prefer for rect/ellipse/polygon/path marks and areas, allow for large circles. */
    AUTO,
    PREFER,
    ALLOW,
    NEVER;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** Canvas sides of the boundary model. */
  public enum Side implements JsonName {
    LEFT,
    RIGHT,
    TOP,
    BOTTOM;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** Arrangement of boundary labels. */
  public enum BoundaryAlign implements JsonName {
    /** As close to the anchors as possible (default). */
    STACK,
    /** Evenly distributed. */
    SPREAD;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** No settings (defaults: adjacent, slider, distant). */
  public static Placement defaults() {
    return new Placement(Map.of());
  }

  /** The candidate models to use. */
  public static Placement models(Model... models) {
    return new Placement(obj("models", Arrays.asList(models)));
  }

  private Placement with(String key, Object value) {
    return new Placement(Spec.with(json, key, value));
  }

  @SuppressWarnings("unchecked")
  private Placement boundary(String key, Object value) {
    Object o = json.get("boundary");
    Map<String, Object> b = o instanceof Map ? (Map<String, Object>) o : Map.of();
    return with("boundary", Spec.with(b, key, value));
  }

  /** A named position order. */
  public Placement positionOrder(PositionOrder order) {
    return with("position_order", order);
  }

  /** An explicit position order; unlisted positions are not generated. */
  public Placement positions(Position... positions) {
    return with("position_order", Arrays.asList(positions));
  }

  /** Gap between the mark and an adjacent label in px (default 2). */
  public Placement offset(double px) {
    return with("offset", len(px));
  }

  /** Gap between the mark and an adjacent label. */
  public Placement offset(String length) {
    return with("offset", len(length));
  }

  /** Largest anchor–label distance of distant labels in px (default 8 em). */
  public Placement maxDistance(double px) {
    return with("max_distance", len(px));
  }

  /** Largest anchor–label distance of distant labels ({@code "10em"}). */
  public Placement maxDistance(String length) {
    return with("max_distance", len(length));
  }

  /** Innermost ring of distant candidates in px (default 1.5 em). */
  public Placement minDistance(double px) {
    return with("min_distance", len(px));
  }

  /** Innermost ring of distant candidates. */
  public Placement minDistance(String length) {
    return with("min_distance", len(length));
  }

  /** Slider samples between two fixed positions (default 4). */
  public Placement sliderPerQuadrant(int n) {
    return with("slider_per_quadrant", n);
  }

  /** Distant candidates kept per item variant (default 24). */
  public Placement kDistant(int n) {
    return with("k_distant", n);
  }

  /** Rings of distant candidates (default 4). */
  public Placement distantRings(int n) {
    return with("distant_rings", n);
  }

  /** Directions per ring for straight leaders (default 16). */
  public Placement distantDirections(int n) {
    return with("distant_directions", n);
  }

  /** Add distant candidates at free-space maxima (default true). */
  public Placement freeSpaceSeeds(boolean enabled) {
    return with("free_space_seeds", enabled);
  }

  /** Internal label policy. */
  public Placement internal(Internal policy) {
    return with("internal", policy);
  }

  /** Clearance of internal labels from the shape boundary in px (default 0.2 em). */
  public Placement innerPadding(double px) {
    return with("inner_padding", len(px));
  }

  /** Clearance of internal labels from the shape boundary. */
  public Placement innerPadding(String length) {
    return with("inner_padding", len(length));
  }

  /** Circles get internal candidates when r &ge; ratio × label height (default 1.5). */
  public Placement internalCircleRatio(double ratio) {
    return with("internal_circle_ratio", ratio);
  }

  /** Drop candidates costing more than factor × the item's best + 1 (default 4). */
  public Placement pruneFactor(double factor) {
    return with("prune_factor", factor);
  }

  /** Canvas sides used by the boundary model (default right, left). */
  public Placement boundarySides(Side... sides) {
    return boundary("sides", Arrays.asList(sides));
  }

  /** Arrangement of boundary labels. */
  public Placement boundaryAlign(BoundaryAlign align) {
    return boundary("align", align);
  }

  /** Gap between stacked boundary labels in px (default 2). */
  public Placement boundaryGap(double px) {
    return boundary("gap", len(px));
  }

  /** Distance of boundary labels from the canvas (region) edge in px (default 4). */
  public Placement boundaryMargin(double px) {
    return boundary("margin", len(px));
  }
}
