package io.github.fabianbeck.labelanything;

import java.util.Map;

/**
 * Vector obstacles of one class (spec §4.2): points, circles, polylines, polygons,
 * rectangles and mark shapes, in input coordinates.
 *
 * <pre>{@code
 * VectorLayer.of("lines").polyline(0, 200, 600, 210).width(4)
 * VectorLayer.of("points").points(new double[][] {{10, 20}, {30, 40}}).r(3)
 * }</pre>
 */
public final class VectorLayer extends Spec {
  private VectorLayer(Map<String, Object> json) {
    super(json);
  }

  /** Fill rule of polygons. */
  public enum FillRule implements JsonName {
    NONZERO,
    EVENODD;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** An empty layer producing obstacles of class {@code className}. */
  public static VectorLayer of(String className) {
    return new VectorLayer(obj("class", className));
  }

  private VectorLayer with(String key, Object value) {
    return new VectorLayer(Spec.with(json, key, value));
  }

  private VectorLayer add(String key, Object value) {
    return new VectorLayer(Spec.append(json, key, value));
  }

  /** A point (a disc of radius {@link #r(double)}). */
  public VectorLayer point(double x, double y) {
    return add("points", new double[] {x, y});
  }

  /** Points {@code {{x, y}, ...}}. */
  public VectorLayer points(double[][] points) {
    VectorLayer l = this;
    for (Object p : points(points, 0, "points")) {
      l = l.add("points", p);
    }
    return l;
  }

  /** Radius of the points in px (default 2). */
  public VectorLayer r(double r) {
    return with("r", r);
  }

  /** A circle. */
  public VectorLayer circle(double x, double y, double r) {
    return add("circles", new double[] {x, y, r});
  }

  /** A polyline {@code {{x, y}, ...}} (at least two points). */
  public VectorLayer polyline(double[][] points) {
    return add("polylines", points(points, 2, "polyline"));
  }

  /** A polyline from flat coordinates {@code x0, y0, x1, y1, ...}. */
  public VectorLayer polyline(double... xy) {
    return polyline(pairs(xy, "polyline"));
  }

  /** Stroke width of the polylines in px (default 1). */
  public VectorLayer width(double width) {
    return with("width", width);
  }

  /** A polygon ring {@code {{x, y}, ...}} (at least three points). */
  public VectorLayer polygon(double[][] ring) {
    return add("polygons", points(ring, 3, "polygon"));
  }

  /** Fill rule of the polygons (default non-zero). */
  public VectorLayer fillRule(FillRule rule) {
    return with("fill_rule", rule);
  }

  /** A rectangle {@code [x, y, w, h]}. */
  public VectorLayer rect(double x, double y, double w, double h) {
    return add("rects", new double[] {x, y, w, h});
  }

  /** A mark shape with its reference point at {@code (x, y)}. */
  public VectorLayer shape(Mark mark, double x, double y) {
    return add("shapes", Spec.with(Spec.with(mark.json, "x", x), "y", y));
  }
}
