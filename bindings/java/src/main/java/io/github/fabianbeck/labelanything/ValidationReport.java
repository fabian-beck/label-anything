package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.util.List;
import java.util.Map;

/**
 * The outcome of {@link LabelAnything#validate}.
 *
 * @param valid whether the problem is valid
 * @param errors errors with JSON pointers (empty when valid)
 * @param warnings warnings (unknown classes, ignored options)
 */
public record ValidationReport(boolean valid, List<Issue> errors, List<Issue> warnings) {
  public ValidationReport {
    errors = List.copyOf(errors);
    warnings = List.copyOf(warnings);
  }

  /** Throw a {@link LabelAnythingException} carrying the errors unless the problem is valid. */
  public ValidationReport orThrow() {
    if (!valid) {
      throw new LabelAnythingException(LabelAnythingException.INVALID, errors);
    }
    return this;
  }

  static ValidationReport parse(String json) {
    Map<String, Object> m = Json.parseObject(json);
    return new ValidationReport(
        Parse.bool(m.get("valid"), false),
        Issue.listFromJson(m.get("errors")),
        Issue.listFromJson(m.get("warnings")));
  }
}
