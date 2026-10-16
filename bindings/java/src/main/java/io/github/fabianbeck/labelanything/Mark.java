package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Geometry of a labeled feature (spec §3.2), or of an unlabeled obstacle shape in a
 * {@link VectorLayer}. The anchor is the shape's reference point: the center of circles,
 * ellipses and rectangles, the tip of icons.
 *
 * <pre>{@code Mark.rect(30, 18).cornerRadius(4)}</pre>
 */
public final class Mark extends Spec {
  private Mark(Map<String, Object> json) {
    super(json);
  }

  private static Mark shape(String shape, Object... kv) {
    Object[] all = new Object[kv.length + 2];
    all[0] = "shape";
    all[1] = shape;
    System.arraycopy(kv, 0, all, 2, kv.length);
    return new Mark(obj(all));
  }

  private Mark with(String key, Object value) {
    return new Mark(Spec.with(json, key, value));
  }

  /** A disc of radius {@code r} px (the default mark is a circle of radius 2). */
  public static Mark circle(double r) {
    return shape("circle", "r", r);
  }

  /** An ellipse with radii {@code rx}, {@code ry} px. */
  public static Mark ellipse(double rx, double ry) {
    return shape("ellipse", "rx", rx, "ry", ry);
  }

  /** A {@code w × h} rectangle centered on the anchor. */
  public static Mark rect(double w, double h) {
    return shape("rect", "w", w, "h", h);
  }

  /** A polygon {@code {{x, y}, ...}} in input coordinates (or offsets, see {@link #relative()}). */
  public static Mark polygon(double[][] points) {
    return shape("polygon", "points", points(points, 3, "polygon"));
  }

  /** SVG path data, flattened with 0.25 px tolerance. */
  public static Mark path(String d) {
    return shape("path", "d", d);
  }

  /** A {@code w × h} icon whose tip (default bottom center) sits on the anchor. */
  public static Mark icon(double w, double h) {
    return shape("icon", "w", w, "h", h);
  }

  /** The geometry of the background SVG element with this id. */
  public static Mark fromSvg(String svgId) {
    return shape("from_svg", "svg_id", svgId);
  }

  /** The geometry of the background SVG elements matching a CSS selector. */
  public static Mark fromSvgSelector(String selector) {
    return shape("from_svg", "selector", selector);
  }

  /** Rotation in degrees, clockwise on screen (ellipse, rect). */
  public Mark rotation(double degrees) {
    return with("rotation", degrees);
  }

  /** Corner radius in px (rect). */
  public Mark cornerRadius(double r) {
    return with("corner_radius", r);
  }

  /** Holes of a polygon. */
  public Mark holes(double[][]... rings) {
    List<Object> out = new ArrayList<>();
    for (double[][] ring : rings) {
      out.add(points(ring, 3, "hole"));
    }
    return with("holes", out);
  }

  /** Polygon points / path coordinates are px offsets from the anchor. */
  public Mark relative() {
    return with("relative", true);
  }

  /** Whether polygon points / path coordinates are px offsets from the anchor. */
  public Mark relative(boolean relative) {
    return with("relative", relative);
  }

  /** Icon tip {@code [dx, dy]} from the icon's top-left corner. */
  public Mark tip(double dx, double dy) {
    return with("tip", new double[] {dx, dy});
  }

  /** Icon outline relative to its top-left corner. */
  public Mark silhouette(double[][] points) {
    return with("silhouette", points(points, 3, "silhouette"));
  }
}
