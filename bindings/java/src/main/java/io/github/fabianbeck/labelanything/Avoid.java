package io.github.fabianbeck.labelanything;

import java.util.Arrays;
import java.util.Map;

/**
 * The avoidance policy (spec §4.4, §8): per obstacle class, {@code "hard"} (never overlap),
 * {@code "ignore"} or a soft weight per covered fraction. Each instance is one section of
 * the {@code avoid} object; the problem merges them key by key over the defaults.
 *
 * <pre>{@code
 * Avoid.label().hard("labels", "outliers").weight("ink", 0.5)
 * Avoid.leader().weight("items", 2.0).ignore("axes")
 * Avoid.buffer().weight("items", 1.0)
 * Avoid.relaxable("points", "ink")
 * }</pre>
 *
 * <p>Reserved classes: {@code items}, {@code labels}, {@code leaders}, {@code canvas_edge},
 * {@code ink}, {@code text}; the key {@code "*"} is the weight of unlisted classes.
 */
public final class Avoid extends Spec {
  final String section;

  private Avoid(String section, Map<String, Object> json) {
    super(json);
    this.section = section;
  }

  /** Label box vs. classes (defaults: labels, items, text, canvas edge hard; ink 0.5). */
  public static Avoid label() {
    return new Avoid("label", Map.of());
  }

  /** Leader vs. classes ({@code leaders} = crossings; defaults: leaders, labels hard). */
  public static Avoid leader() {
    return new Avoid("leader", Map.of());
  }

  /** Soft ambiguity buffer ring around labels vs. classes (weights only). */
  public static Avoid buffer() {
    return new Avoid("buffer", Map.of());
  }

  /** Hard classes the {@code soft_overlap} ladder step may relax to a soft weight. */
  public static Avoid relaxable(String... classes) {
    return new Avoid("relaxable", obj("relaxable", Arrays.asList(classes)));
  }

  private Avoid set(String cls, Object value) {
    if (section.equals("relaxable")) {
      throw new IllegalStateException("Avoid.relaxable() takes class names only");
    }
    return new Avoid(section, Spec.with(json, cls, value));
  }

  /** Never overlap these classes. */
  public Avoid hard(String... classes) {
    Avoid a = this;
    for (String c : classes) {
      a = a.set(c, "hard");
    }
    return a;
  }

  /** No interaction with these classes. */
  public Avoid ignore(String... classes) {
    Avoid a = this;
    for (String c : classes) {
      a = a.set(c, "ignore");
    }
    return a;
  }

  /** Soft weight (&ge; 0) per unit of covered fraction. */
  public Avoid weight(String cls, double weight) {
    return set(cls, weight);
  }

  /** Own-mark policy of external labels: cover at most {@code fraction} of the own mark. */
  public Avoid ownMarkPartial(double fraction) {
    if (!section.equals("label")) {
      throw new IllegalStateException("own_mark applies to Avoid.label() only");
    }
    return set("own_mark", "partial:" + plainNumber(fraction));
  }

  /** The fragment as it appears under {@code avoid}. */
  Map<String, Object> fragment() {
    return section.equals("relaxable") ? json : obj(section, json);
  }

  @Override
  Object jsonValue() {
    return fragment();
  }
}
