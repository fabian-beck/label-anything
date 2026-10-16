package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Base of the immutable option objects ({@link Label}, {@link Mark}, {@link Leaders}, ...):
 * a JSON object fragment of the problem. Every fluent method returns a new object.
 */
abstract class Spec {
  /** Unmodifiable, holds plain JSON values only (Map, List, String, Number, Boolean). */
  final Map<String, Object> json;

  Spec(Map<String, Object> json) {
    this.json = json;
  }

  /** The JSON value this object contributes (usually {@link #json}). */
  Object jsonValue() {
    return json;
  }

  /** The JSON fragment this object stands for (as it appears in the problem). */
  public String toJson() {
    return Json.write(jsonValue());
  }

  @Override
  public String toString() {
    return getClass().getSimpleName() + toJson();
  }

  @Override
  public boolean equals(Object o) {
    return o != null
        && o.getClass() == getClass()
        && Json.equalValues(jsonValue(), ((Spec) o).jsonValue());
  }

  @Override
  public int hashCode() {
    Object v = jsonValue();
    return Objects.hash(getClass(), v instanceof Map<?, ?> m ? m.keySet() : null);
  }

  // ------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------

  static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      if (kv[i + 1] != null) {
        m.put((String) kv[i], plain(kv[i + 1]));
      }
    }
    return Collections.unmodifiableMap(m);
  }

  /** A copy of {@code m} with {@code key} set ({@code null} removes it). */
  static Map<String, Object> with(Map<String, Object> m, String key, Object value) {
    Map<String, Object> out = new LinkedHashMap<>(m);
    if (value == null) {
      out.remove(key);
    } else {
      out.put(key, plain(value));
    }
    return Collections.unmodifiableMap(out);
  }

  /** A copy of {@code m} with the list at {@code key} extended by {@code value}. */
  static Map<String, Object> append(Map<String, Object> m, String key, Object value) {
    List<Object> list = new ArrayList<>();
    Object old = m.get(key);
    if (old instanceof List<?> l) {
      list.addAll(l);
    }
    list.add(plain(value));
    return with(m, key, Collections.unmodifiableList(list));
  }

  /** Convert option objects, enums, paths and arrays to plain JSON values. */
  static Object plain(Object v) {
    if (v == null || v instanceof String || v instanceof Boolean) {
      return v;
    }
    if (v instanceof Number n) {
      if (n instanceof Double d && (d.isNaN() || d.isInfinite())
          || n instanceof Float f && (f.isNaN() || f.isInfinite())) {
        throw new IllegalArgumentException("not a finite number: " + n);
      }
      return n;
    }
    if (v instanceof Spec s) {
      return s.json;
    }
    if (v instanceof JsonName e) {
      return e.jsonName();
    }
    if (v instanceof Enum<?> e) {
      return e.name().toLowerCase(java.util.Locale.ROOT);
    }
    if (v instanceof Path p) {
      return p.toAbsolutePath().toString();
    }
    if (v instanceof CharSequence cs) {
      return cs.toString();
    }
    if (v instanceof Map<?, ?> m) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<?, ?> e : m.entrySet()) {
        out.put(String.valueOf(e.getKey()), plain(e.getValue()));
      }
      return Collections.unmodifiableMap(out);
    }
    if (v instanceof Collection<?> c) {
      List<Object> out = new ArrayList<>(c.size());
      for (Object o : c) {
        out.add(plain(o));
      }
      return Collections.unmodifiableList(out);
    }
    if (v instanceof double[] a) {
      List<Object> out = new ArrayList<>(a.length);
      for (double d : a) {
        out.add(plain(d));
      }
      return Collections.unmodifiableList(out);
    }
    if (v instanceof int[] a) {
      return plain(Arrays.stream(a).boxed().toList());
    }
    if (v instanceof long[] a) {
      return plain(Arrays.stream(a).boxed().toList());
    }
    if (v instanceof Object[] a) {
      return plain(Arrays.asList(a));
    }
    throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
  }

  /** {@code [[x, y], ...]} from {@code {{x, y}, ...}}; every row must have two numbers. */
  static List<Object> points(double[][] pts, int minPoints, String what) {
    Objects.requireNonNull(pts, what);
    if (pts.length < minPoints) {
      throw new IllegalArgumentException(what + " needs at least " + minPoints + " points");
    }
    List<Object> out = new ArrayList<>(pts.length);
    for (double[] p : pts) {
      if (p == null || p.length != 2) {
        throw new IllegalArgumentException(what + ": every point is {x, y}");
      }
      out.add(plain(p));
    }
    return Collections.unmodifiableList(out);
  }

  /** {@code [[x, y], ...]} from a flat {@code x0, y0, x1, y1, ...} array. */
  static double[][] pairs(double[] flat, String what) {
    if (flat.length % 2 != 0) {
      throw new IllegalArgumentException(what + ": coordinates come in x, y pairs");
    }
    double[][] out = new double[flat.length / 2][];
    for (int i = 0; i < out.length; i++) {
      out[i] = new double[] {flat[2 * i], flat[2 * i + 1]};
    }
    return out;
  }

  /** A non-negative number without exponent ({@code 3}, {@code 0.85}) for string options. */
  static String plainNumber(double d) {
    if (!(d >= 0) || Double.isInfinite(d)) {
      throw new IllegalArgumentException("expected a finite number >= 0, got " + d);
    }
    return java.math.BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
  }

  /** A length option: pixels as a number. */
  static Object len(double px) {
    return px;
  }

  /** A length option given with a unit ({@code "0.5em"}, {@code "3px"}, {@code "2pt"}). */
  static Object len(String length) {
    return Objects.requireNonNull(length, "length");
  }
}
