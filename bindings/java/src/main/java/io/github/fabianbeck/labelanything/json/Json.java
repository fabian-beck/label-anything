package io.github.fabianbeck.labelanything.json;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * A small JSON reader and writer (RFC 8259), so the binding has no runtime dependencies.
 *
 * <p>Values map to Java as follows: object = {@link Map} ({@link LinkedHashMap}, key order
 * kept), array = {@link List}, string = {@link String}, number = {@link Long} for integer
 * literals that fit, else {@link Double}, {@code true}/{@code false} = {@link Boolean},
 * {@code null} = {@code null}.
 *
 * <p>{@link #write(Object)} also accepts other {@link Number}s, {@link Iterable}s, arrays
 * (including primitive arrays), {@link Enum}s (written as their name) and {@link
 * CharSequence}s. Doubles with an integral value are written without a fraction ({@code
 * 120.0} becomes {@code 120}); NaN and infinities are rejected.
 */
public final class Json {
  private static final int MAX_DEPTH = 1000;

  private Json() {}

  // ------------------------------------------------------------------------------------
  // Writing
  // ------------------------------------------------------------------------------------

  /** Serialize a value compactly. */
  public static String write(Object value) {
    StringBuilder sb = new StringBuilder(256);
    write(sb, value, -1, 0);
    return sb.toString();
  }

  /** Serialize a value with two-space indentation. */
  public static String writePretty(Object value) {
    StringBuilder sb = new StringBuilder(256);
    write(sb, value, 2, 0);
    return sb.toString();
  }

  /** Append the JSON string literal of {@code s} (with quotes) to {@code sb}. */
  public static void quote(StringBuilder sb, CharSequence s) {
    sb.append('"');
    for (int i = 0, n = s.length(); i < n; i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        default -> {
          if (c < 0x20 || c == 0x2028 || c == 0x2029) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
        }
      }
    }
    sb.append('"');
  }

  /** The JSON text of a number (integral doubles without fraction). */
  public static String number(double d) {
    if (Double.isNaN(d) || Double.isInfinite(d)) {
      throw new IllegalArgumentException("JSON cannot represent " + d);
    }
    if (d == Math.rint(d) && Math.abs(d) < 1e15 && !(d == 0 && 1 / d < 0)) {
      return Long.toString((long) d);
    }
    return Double.toString(d);
  }

  private static void write(StringBuilder sb, Object v, int indent, int depth) {
    if (depth > MAX_DEPTH) {
      throw new IllegalArgumentException("JSON nesting deeper than " + MAX_DEPTH);
    }
    if (v == null) {
      sb.append("null");
    } else if (v instanceof CharSequence s) {
      quote(sb, s);
    } else if (v instanceof Boolean b) {
      sb.append(b.booleanValue());
    } else if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (v instanceof Float f && !Float.isNaN(f) && !Float.isInfinite(f) && d != Math.rint(d)) {
        sb.append(Float.toString(f)); // the float's shortest decimal, not its double expansion
      } else {
        sb.append(number(d));
      }
    } else if (v instanceof BigDecimal bd) {
      sb.append(bd.toString());
    } else if (v instanceof Number n) { // Integer, Long, Short, Byte, BigInteger, atomics
      if (n instanceof BigInteger || n instanceof Long || n instanceof Integer
          || n instanceof Short || n instanceof Byte) {
        sb.append(n.toString());
      } else {
        sb.append(number(n.doubleValue()));
      }
    } else if (v instanceof Map<?, ?> m) {
      writeMap(sb, m, indent, depth);
    } else if (v instanceof Iterable<?> it) {
      List<Object> items = new ArrayList<>();
      it.forEach(items::add);
      writeList(sb, items, indent, depth);
    } else if (v.getClass().isArray()) {
      int n = Array.getLength(v);
      List<Object> items = new ArrayList<>(n);
      for (int i = 0; i < n; i++) {
        items.add(Array.get(v, i));
      }
      writeList(sb, items, indent, depth);
    } else if (v instanceof Enum<?> e) {
      quote(sb, e.name());
    } else if (v instanceof Character c) {
      quote(sb, String.valueOf(c));
    } else {
      throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
    }
  }

  private static void newline(StringBuilder sb, int indent, int depth) {
    if (indent >= 0) {
      sb.append('\n');
      for (int i = 0; i < indent * depth; i++) {
        sb.append(' ');
      }
    }
  }

  private static void writeMap(StringBuilder sb, Map<?, ?> m, int indent, int depth) {
    if (m.isEmpty()) {
      sb.append("{}");
      return;
    }
    sb.append('{');
    boolean first = true;
    for (Map.Entry<?, ?> e : m.entrySet()) {
      if (!first) {
        sb.append(',');
      }
      first = false;
      newline(sb, indent, depth + 1);
      quote(sb, String.valueOf(e.getKey()));
      sb.append(indent >= 0 ? ": " : ":");
      write(sb, e.getValue(), indent, depth + 1);
    }
    newline(sb, indent, depth);
    sb.append('}');
  }

  private static void writeList(StringBuilder sb, List<Object> items, int indent, int depth) {
    if (items.isEmpty()) {
      sb.append("[]");
      return;
    }
    sb.append('[');
    for (int i = 0; i < items.size(); i++) {
      if (i > 0) {
        sb.append(',');
      }
      newline(sb, indent, depth + 1);
      write(sb, items.get(i), indent, depth + 1);
    }
    newline(sb, indent, depth);
    sb.append(']');
  }

  // ------------------------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------------------------

  /**
   * Parse JSON text.
   *
   * @throws IllegalArgumentException with the offending offset when the text is not JSON
   */
  public static Object parse(String text) {
    Objects.requireNonNull(text, "text");
    Parser p = new Parser(text);
    p.ws();
    Object v = p.value(0);
    p.ws();
    if (p.pos != text.length()) {
      throw p.error("trailing characters");
    }
    return v;
  }

  /** Parse JSON text that must be an object. */
  @SuppressWarnings("unchecked")
  public static Map<String, Object> parseObject(String text) {
    Object v = parse(text);
    if (!(v instanceof Map)) {
      throw new IllegalArgumentException("JSON text is not an object");
    }
    return (Map<String, Object>) v;
  }

  private static final class Parser {
    final String s;
    int pos;

    Parser(String s) {
      this.s = s;
    }

    IllegalArgumentException error(String what) {
      return new IllegalArgumentException("invalid JSON at offset " + pos + ": " + what);
    }

    void ws() {
      while (pos < s.length()) {
        char c = s.charAt(pos);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
          pos++;
        } else {
          break;
        }
      }
    }

    Object value(int depth) {
      if (depth > MAX_DEPTH) {
        throw error("nesting deeper than " + MAX_DEPTH);
      }
      if (pos >= s.length()) {
        throw error("unexpected end");
      }
      char c = s.charAt(pos);
      switch (c) {
        case '{':
          return object(depth);
        case '[':
          return array(depth);
        case '"':
          return string();
        case 't':
          literal("true");
          return Boolean.TRUE;
        case 'f':
          literal("false");
          return Boolean.FALSE;
        case 'n':
          literal("null");
          return null;
        default:
          if (c == '-' || (c >= '0' && c <= '9')) {
            return number();
          }
          throw error("unexpected character '" + c + "'");
      }
    }

    void literal(String word) {
      if (!s.startsWith(word, pos)) {
        throw error("expected " + word);
      }
      pos += word.length();
    }

    Map<String, Object> object(int depth) {
      pos++; // {
      Map<String, Object> m = new LinkedHashMap<>();
      ws();
      if (pos < s.length() && s.charAt(pos) == '}') {
        pos++;
        return m;
      }
      while (true) {
        ws();
        if (pos >= s.length() || s.charAt(pos) != '"') {
          throw error("expected a string key");
        }
        String k = string();
        ws();
        if (pos >= s.length() || s.charAt(pos) != ':') {
          throw error("expected ':'");
        }
        pos++;
        ws();
        m.put(k, value(depth + 1));
        ws();
        if (pos >= s.length()) {
          throw error("unexpected end in object");
        }
        char c = s.charAt(pos++);
        if (c == '}') {
          return m;
        }
        if (c != ',') {
          pos--;
          throw error("expected ',' or '}'");
        }
      }
    }

    List<Object> array(int depth) {
      pos++; // [
      List<Object> a = new ArrayList<>();
      ws();
      if (pos < s.length() && s.charAt(pos) == ']') {
        pos++;
        return a;
      }
      while (true) {
        ws();
        a.add(value(depth + 1));
        ws();
        if (pos >= s.length()) {
          throw error("unexpected end in array");
        }
        char c = s.charAt(pos++);
        if (c == ']') {
          return a;
        }
        if (c != ',') {
          pos--;
          throw error("expected ',' or ']'");
        }
      }
    }

    String string() {
      pos++; // opening quote
      StringBuilder sb = null;
      int start = pos;
      while (true) {
        if (pos >= s.length()) {
          throw error("unterminated string");
        }
        char c = s.charAt(pos);
        if (c == '"') {
          String out = sb == null ? s.substring(start, pos) : sb.append(s, start, pos).toString();
          pos++;
          return out;
        }
        if (c < 0x20) {
          throw error("control character in string");
        }
        if (c == '\\') {
          if (sb == null) {
            sb = new StringBuilder();
          }
          sb.append(s, start, pos);
          pos++;
          if (pos >= s.length()) {
            throw error("unterminated escape");
          }
          char e = s.charAt(pos++);
          switch (e) {
            case '"' -> sb.append('"');
            case '\\' -> sb.append('\\');
            case '/' -> sb.append('/');
            case 'b' -> sb.append('\b');
            case 'f' -> sb.append('\f');
            case 'n' -> sb.append('\n');
            case 'r' -> sb.append('\r');
            case 't' -> sb.append('\t');
            case 'u' -> {
              if (pos + 4 > s.length()) {
                throw error("short \\u escape");
              }
              int cp = 0;
              for (int i = 0; i < 4; i++) {
                int h = Character.digit(s.charAt(pos + i), 16);
                if (h < 0) {
                  throw error("bad \\u escape");
                }
                cp = cp * 16 + h;
              }
              pos += 4;
              sb.append((char) cp);
            }
            default -> {
              pos--;
              throw error("bad escape '\\" + e + "'");
            }
          }
          start = pos;
        } else {
          pos++;
        }
      }
    }

    Object number() {
      int start = pos;
      boolean integral = true;
      if (s.charAt(pos) == '-') {
        pos++;
      }
      if (pos >= s.length()) {
        throw error("bad number");
      }
      if (s.charAt(pos) == '0') {
        pos++;
      } else if (s.charAt(pos) >= '1' && s.charAt(pos) <= '9') {
        while (pos < s.length() && s.charAt(pos) >= '0' && s.charAt(pos) <= '9') {
          pos++;
        }
      } else {
        throw error("bad number");
      }
      if (pos < s.length() && s.charAt(pos) == '.') {
        integral = false;
        pos++;
        int d = pos;
        while (pos < s.length() && s.charAt(pos) >= '0' && s.charAt(pos) <= '9') {
          pos++;
        }
        if (pos == d) {
          throw error("digit expected after '.'");
        }
      }
      if (pos < s.length() && (s.charAt(pos) == 'e' || s.charAt(pos) == 'E')) {
        integral = false;
        pos++;
        if (pos < s.length() && (s.charAt(pos) == '+' || s.charAt(pos) == '-')) {
          pos++;
        }
        int d = pos;
        while (pos < s.length() && s.charAt(pos) >= '0' && s.charAt(pos) <= '9') {
          pos++;
        }
        if (pos == d) {
          throw error("digit expected in exponent");
        }
      }
      String lit = s.substring(start, pos);
      if (integral && !lit.equals("-0")) {
        if (lit.length() <= 18) {
          return Long.parseLong(lit);
        }
        try {
          return Long.parseLong(lit);
        } catch (NumberFormatException overflow) {
          return Double.parseDouble(lit);
        }
      }
      return Double.parseDouble(lit);
    }
  }

  // ------------------------------------------------------------------------------------
  // Helpers for reading parsed values
  // ------------------------------------------------------------------------------------

  /** Deep, unmodifiable copy of a parsed value (maps keep their order). */
  @SuppressWarnings("unchecked")
  public static Object freeze(Object v) {
    if (v instanceof Map<?, ?> m) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<?, ?> e : m.entrySet()) {
        out.put(String.valueOf(e.getKey()), freeze(e.getValue()));
      }
      return Collections.unmodifiableMap(out);
    }
    if (v instanceof List<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (Object o : l) {
        out.add(freeze(o));
      }
      return Collections.unmodifiableList(out);
    }
    return v;
  }

  /**
   * Structural equality of two parsed values where numbers compare by value ({@code 1}
   * equals {@code 1.0}).
   */
  public static boolean equalValues(Object a, Object b) {
    if (a instanceof Number x && b instanceof Number y) {
      return Double.compare(x.doubleValue(), y.doubleValue()) == 0
          || x.doubleValue() == y.doubleValue();
    }
    if (a instanceof Map<?, ?> x && b instanceof Map<?, ?> y) {
      if (x.size() != y.size()) {
        return false;
      }
      for (Map.Entry<?, ?> e : x.entrySet()) {
        if (!y.containsKey(e.getKey()) || !equalValues(e.getValue(), y.get(e.getKey()))) {
          return false;
        }
      }
      return true;
    }
    if (a instanceof List<?> x && b instanceof List<?> y) {
      if (x.size() != y.size()) {
        return false;
      }
      for (int i = 0; i < x.size(); i++) {
        if (!equalValues(x.get(i), y.get(i))) {
          return false;
        }
      }
      return true;
    }
    return Objects.equals(a, b);
  }
}
