package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A validation error or warning.
 *
 * @param pointer RFC 6901 JSON Pointer into the problem ({@code ""} = the whole problem)
 * @param code machine-readable code, e.g. {@code required}, {@code range}, {@code unknown_property}
 * @param message human-readable message
 */
public record Issue(String pointer, String code, String message) {
  @Override
  public String toString() {
    return (pointer == null || pointer.isEmpty() ? "/" : pointer) + " [" + code + "] " + message;
  }

  static Issue fromJson(Object o) {
    var m = Parse.map(o);
    String pointer = Parse.str(m.get("pointer"));
    String code = Parse.str(m.get("code"));
    String message = Parse.str(m.get("message"));
    return new Issue(pointer == null ? "" : pointer, code == null ? "" : code,
        message == null ? "" : message);
  }

  static List<Issue> listFromJson(Object o) {
    List<Issue> out = new ArrayList<>();
    for (Object e : Parse.list(o)) {
      out.add(fromJson(e));
    }
    return Collections.unmodifiableList(out);
  }
}
