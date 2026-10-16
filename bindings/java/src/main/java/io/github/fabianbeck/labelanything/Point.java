package io.github.fabianbeck.labelanything;

/** A point in canvas pixels. */
public record Point(double x, double y) {
  /** Euclidean distance to another point. */
  public double distance(Point o) {
    return Math.hypot(o.x - x, o.y - y);
  }
}
