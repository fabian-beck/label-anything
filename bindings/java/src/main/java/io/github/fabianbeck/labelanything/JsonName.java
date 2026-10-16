package io.github.fabianbeck.labelanything;

import java.util.Locale;

/** Enums of the problem/result vocabulary: each constant has a JSON spelling. */
interface JsonName {
  /** The value as written in the problem or result JSON. */
  String jsonName();

  /** Lower case constant name ({@code TOP_RIGHT} → {@code top_right}). */
  static String lower(Enum<?> e) {
    return e.name().toLowerCase(Locale.ROOT);
  }

  /** Lower case with hyphens ({@code TOP_RIGHT} → {@code top-right}). */
  static String hyphen(Enum<?> e) {
    return lower(e).replace('_', '-');
  }

  /** The constant spelled {@code s} in JSON, or {@code null} for null/unknown values. */
  static <E extends Enum<E> & JsonName> E parse(Class<E> type, Object s) {
    if (s instanceof String str) {
      for (E e : type.getEnumConstants()) {
        if (e.jsonName().equals(str)) {
          return e;
        }
      }
    }
    return null;
  }
}
