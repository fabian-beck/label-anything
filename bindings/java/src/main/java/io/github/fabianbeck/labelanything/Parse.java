package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Lenient accessors for parsed result JSON (absent or mistyped values give defaults). */
final class Parse {
  private Parse() {}

  @SuppressWarnings("unchecked")
  static Map<String, Object> map(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : Map.of();
  }

  @SuppressWarnings("unchecked")
  static List<Object> list(Object o) {
    return o instanceof List ? (List<Object>) o : List.of();
  }

  static String str(Object o) {
    return o instanceof String s ? s : null;
  }

  static double dbl(Object o, double fallback) {
    return o instanceof Number n ? n.doubleValue() : fallback;
  }

  static int integer(Object o, int fallback) {
    return o instanceof Number n ? n.intValue() : fallback;
  }

  static long lng(Object o, long fallback) {
    return o instanceof Number n ? n.longValue() : fallback;
  }

  static boolean bool(Object o, boolean fallback) {
    return o instanceof Boolean b ? b : fallback;
  }

  static List<String> strings(Object o) {
    List<String> out = new ArrayList<>();
    for (Object e : list(o)) {
      if (e instanceof String s) {
        out.add(s);
      }
    }
    return Collections.unmodifiableList(out);
  }

  static Map<String, Integer> intMap(Object o) {
    Map<String, Integer> out = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : map(o).entrySet()) {
      if (e.getValue() instanceof Number n) {
        out.put(e.getKey(), n.intValue());
      }
    }
    return Collections.unmodifiableMap(out);
  }

  static Point point(Object o) {
    List<Object> l = list(o);
    if (l.size() < 2 || !(l.get(0) instanceof Number) || !(l.get(1) instanceof Number)) {
      return null;
    }
    return new Point(dbl(l.get(0), 0), dbl(l.get(1), 0));
  }

  static List<Point> points(Object o) {
    List<Point> out = new ArrayList<>();
    for (Object e : list(o)) {
      Point p = point(e);
      if (p != null) {
        out.add(p);
      }
    }
    return Collections.unmodifiableList(out);
  }
}
