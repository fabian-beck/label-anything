package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The result of a solve (result.v1).
 *
 * @param placements one entry per item, in input order
 * @param omissionOrder omitted ids from the lowest priority upward ({@code stats.omission_order})
 * @param stats statistics (typed, plus {@link Stats#raw()})
 * @param warnings validation warnings (unknown classes, ignored options)
 * @param debugSvg the debug overlay when {@code output.debug_svg} was requested, else null
 * @param json the result JSON text as returned by the engine
 */
public record LabelResult(
    List<LabelPlacement> placements,
    List<String> omissionOrder,
    Stats stats,
    List<Issue> warnings,
    String debugSvg,
    String json) {
  public LabelResult {
    placements = List.copyOf(placements);
    omissionOrder = List.copyOf(omissionOrder);
    warnings = List.copyOf(warnings);
  }

  /** Parse a result JSON text (e.g. written by the CLI). */
  public static LabelResult parse(String json) {
    Map<String, Object> root = Parse.map(Json.freeze(Json.parseObject(json)));
    List<LabelPlacement> placements = new ArrayList<>();
    for (Object p : Parse.list(root.get("placements"))) {
      placements.add(LabelPlacement.fromJson(p));
    }
    Stats stats = Stats.fromJson(root.get("stats"));
    return new LabelResult(
        placements,
        stats.omissionOrder(),
        stats,
        Issue.listFromJson(root.get("warnings")),
        Parse.str(root.get("debug_svg")),
        json);
  }

  /** The placement of an item. */
  public Optional<LabelPlacement> placement(String id) {
    for (LabelPlacement p : placements) {
      if (p.id() != null && p.id().equals(id)) {
        return Optional.of(p);
      }
    }
    return Optional.empty();
  }

  /** The placed labels only. */
  public List<LabelPlacement> placed() {
    return placements.stream().filter(LabelPlacement::placed).toList();
  }

  @Override
  public String toString() {
    return "LabelResult[placed=" + stats.placed() + "/" + stats.total()
        + ", hardViolations=" + stats.hardViolations() + "]";
  }
}
