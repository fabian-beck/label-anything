package io.github.fabianbeck.labelanything;

/** An axis-aligned label box in canvas pixels (origin top-left, y down). */
public record Box(double x, double y, double w, double h) {
  /** Right edge. */
  public double maxX() {
    return x + w;
  }

  /** Bottom edge. */
  public double maxY() {
    return y + h;
  }

  /** Horizontal center. */
  public double centerX() {
    return x + w / 2;
  }

  /** Vertical center. */
  public double centerY() {
    return y + h / 2;
  }

  /** Whether the interiors of the two boxes overlap (touching edges do not). */
  public boolean intersects(Box o) {
    return x < o.maxX() && o.x < maxX() && y < o.maxY() && o.y < maxY();
  }

  /** Whether the point lies inside or on the box. */
  public boolean contains(double px, double py) {
    return px >= x && px <= maxX() && py >= y && py <= maxY();
  }

  static Box fromJson(Object o) {
    var m = Parse.map(o);
    if (!m.containsKey("x")) {
      return null;
    }
    return new Box(Parse.dbl(m.get("x"), 0), Parse.dbl(m.get("y"), 0),
        Parse.dbl(m.get("w"), 0), Parse.dbl(m.get("h"), 0));
  }
}
