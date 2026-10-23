package io.github.fabianbeck.labelanything;

import java.util.List;

/**
 * A leader line of a placed label.
 *
 * @param points polyline from the item (boundary + anchor gap, or the icon tip) to the port
 * @param style the leader style
 * @param port where the leader meets the label
 * @param underline for {@code baseline} ports: the underline below the first text line (else empty)
 * @param curve for curved leaders: {@code [start, control, end]} of the quadratic Bezier (else empty)
 * @param member for fan leaders of a group label: the member id this leader points to (else null)
 * @param stub whether this is the stub of a label next to its mark among other marks (spec §6.9)
 */
public record Leader(
    List<Point> points,
    LeaderStyle style,
    Point port,
    List<Point> underline,
    List<Point> curve,
    String member,
    boolean stub) {
  public Leader {
    points = List.copyOf(points);
    underline = List.copyOf(underline);
    curve = List.copyOf(curve);
  }

  /** Length of the polyline in px. */
  public double length() {
    double l = 0;
    for (int i = 1; i < points.size(); i++) {
      l += points.get(i - 1).distance(points.get(i));
    }
    return l;
  }

  static Leader fromJson(Object o) {
    var m = Parse.map(o);
    if (m.isEmpty()) {
      return null;
    }
    return new Leader(
        Parse.points(m.get("points")),
        LeaderStyle.fromJson(Parse.str(m.get("style"))),
        Parse.point(m.get("port")),
        Parse.points(m.get("underline")),
        Parse.points(m.get("curve")),
        Parse.str(m.get("member")),
        Boolean.TRUE.equals(m.get("stub")));
  }
}
