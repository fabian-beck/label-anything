package io.github.fabianbeck.labelanything;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.fabianbeck.labelanything.json.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonTest {
  @Test
  void parsesAllValueKinds() {
    Map<String, Object> m = Json.parseObject(
        " {\"a\": 1, \"b\": -2.5e3, \"c\": [true, false, null], \"d\": {\"e\": \"x\"}, \"f\": 0.1} ");
    assertEquals(1L, m.get("a"));
    assertEquals(-2500.0, m.get("b"));
    assertEquals(java.util.Arrays.asList(true, false, null), m.get("c"));
    assertEquals(Map.of("e", "x"), m.get("d"));
    assertEquals(0.1, m.get("f"));
    assertEquals(List.of("a", "b", "c", "d", "f"), List.copyOf(m.keySet()), "key order kept");
  }

  @Test
  void numbers() {
    assertEquals(9007199254740993L, Json.parse("9007199254740993"));
    assertEquals(1e19, Json.parse("10000000000000000000"));
    assertEquals(-0.0, Json.parse("-0"));
    assertEquals(1.5e-7, Json.parse("1.5E-7"));
    assertEquals("120", Json.write(120.0));
    assertEquals("-3", Json.write(-3.0));
    assertEquals("0.5", Json.write(0.5));
    assertEquals("0.1", Json.write(0.1f));
    assertEquals("1.0E20", Json.write(1e20));
    assertEquals("-0.0", Json.write(-0.0));
    assertEquals(0.1 + 0.2, Json.parse(Json.write(0.1 + 0.2)));
    assertThrows(IllegalArgumentException.class, () -> Json.write(Double.NaN));
    assertThrows(IllegalArgumentException.class, () -> Json.write(Double.POSITIVE_INFINITY));
  }

  @Test
  void stringsAndEscapes() {
    String s = "quote \" backslash \\ slash / tab \t nl \n ctrl \u0001 caf\u00e9 \ud83d\ude00";
    String json = Json.write(s);
    assertTrue(json.contains("\\u0001"));
    assertEquals(s, Json.parse(json));
    assertEquals("\u00e9\ud83d\ude00/", Json.parse("\"\\u00e9\\ud83d\\ude00\\/\""));
  }

  @Test
  void writesCollectionsArraysAndMaps() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("list", List.of(1, 2.5, "x"));
    m.put("array", new double[] {1, 2});
    m.put("nested", new int[][] {{1, 2}, {3}});
    m.put("null", null);
    assertEquals(
        "{\"list\":[1,2.5,\"x\"],\"array\":[1,2],\"nested\":[[1,2],[3]],\"null\":null}",
        Json.write(m));
    assertEquals("{\n  \"a\": [\n    1\n  ]\n}", Json.writePretty(Map.of("a", List.of(1))));
  }

  @Test
  void rejectsInvalidJsonWithOffset() {
    for (String bad : new String[] {"", "{", "[1,]", "{\"a\" 1}", "01", "1.", "\"abc", "tru",
        "{\"a\":1}x", "\"\\x\"", "[1 2]", "-", "1e"}) {
      IllegalArgumentException e =
          assertThrows(IllegalArgumentException.class, () -> Json.parse(bad), bad);
      assertTrue(e.getMessage().contains("offset"), e.getMessage());
    }
  }

  @Test
  void equalValuesComparesNumbersByValue() {
    assertTrue(Json.equalValues(Json.parse("{\"a\":[1,2.0]}"), Json.parse("{\"a\":[1.0,2]}")));
    assertFalse(Json.equalValues(Json.parse("{\"a\":1}"), Json.parse("{\"a\":1,\"b\":2}")));
    assertFalse(Json.equalValues(Json.parse("[1]"), Json.parse("[\"1\"]")));
    assertNull(Json.parse("null"));
  }

  @Test
  void freezeIsDeepAndUnmodifiable() {
    @SuppressWarnings("unchecked")
    Map<String, Object> m = (Map<String, Object>) Json.freeze(Json.parse("{\"a\":{\"b\":[1]}}"));
    assertThrows(UnsupportedOperationException.class, () -> m.put("x", 1));
    @SuppressWarnings("unchecked")
    List<Object> l = (List<Object>) ((Map<String, Object>) m.get("a")).get("b");
    assertThrows(UnsupportedOperationException.class, () -> l.add(2));
  }
}
