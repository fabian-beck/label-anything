package io.github.fabianbeck.labelanything;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The resolved priority key of an item (spec §9.1).
 *
 * @param tier the tier
 * @param score the score (explicit priority or weighted terms)
 * @param rank position in the total priority order (0 = highest)
 * @param required whether the item is required
 * @param reserved whether a coverage constraint lifted the item
 * @param terms normalized term values by term name (only reported when terms are used)
 */
public record PriorityInfo(
    int tier, double score, int rank, boolean required, boolean reserved, Map<String, Double> terms) {
  public PriorityInfo {
    terms = Map.copyOf(terms);
  }

  static PriorityInfo fromJson(Object o) {
    var m = Parse.map(o);
    if (m.isEmpty()) {
      return null;
    }
    Map<String, Double> terms = new LinkedHashMap<>();
    Parse.map(m.get("terms")).forEach((k, v) -> {
      if (v instanceof Number n) {
        terms.put(k, n.doubleValue());
      }
    });
    return new PriorityInfo(
        Parse.integer(m.get("tier"), 0),
        Parse.dbl(m.get("score"), 0),
        Parse.integer(m.get("rank"), 0),
        Parse.bool(m.get("required"), false),
        Parse.bool(m.get("reserved"), false),
        terms);
  }
}
