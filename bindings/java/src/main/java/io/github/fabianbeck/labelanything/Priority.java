package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.ToDoubleFunction;

/**
 * The priority score that decides which labels are omitted first (spec §9): a weighted
 * sum of terms, each a data attribute, an expression or a built-in measure, transformed
 * and normalized across items by the engine.
 *
 * <pre>{@code
 * Priority.attr("traffic").log1p().plus(Priority.outlierness(5))
 * Priority.attr("cbo").log1p().times(0.5).minus(Priority.labelSize().times(0.2))
 * Priority.callback(item -> item.attr("population", 0) / 1e6)
 * }</pre>
 *
 * <p>Transforms ({@link #log1p()}, ...), {@link #normalize}, {@link #weight} and {@link #k}
 * apply to a single term, before {@link #plus}/{@link #minus}; {@link #times} scales every
 * term. A {@linkplain #callback callback} is evaluated in Java when the problem is built
 * and writes explicit {@code priority} values into the items that have none; it combines
 * with other callbacks, not with engine terms.
 */
public final class Priority {
  /** Built-in priority measures. */
  public enum Builtin implements JsonName {
    /** Distance to the k nearest neighbours (high for outliers). */
    OUTLIERNESS,
    ISOLATION,
    CROWDING,
    LABEL_SIZE,
    MARK_SIZE,
    /** Closeness to {@code priority.focus} (default: canvas center). */
    CENTRALITY,
    /** Graph degree. */
    DEGREE,
    INPUT_ORDER;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** Normalization of a term across items. */
  public enum Normalize implements JsonName {
    /** Average rank scaled to [0, 1] (default). */
    RANK,
    /** (v − min) / (max − min). */
    MINMAX,
    /** Raw values. */
    NONE;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** Transform of raw term values before normalization. */
  public enum Transform implements JsonName {
    NONE,
    LOG1P,
    SQRT,
    NEG,
    ABS;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  private final List<Map<String, Object>> terms;
  private final ToDoubleFunction<Item> callback;

  private Priority(List<Map<String, Object>> terms, ToDoubleFunction<Item> callback) {
    this.terms = terms;
    this.callback = callback;
  }

  private static Priority term(String key, Object value) {
    return new Priority(List.of(Spec.obj(key, value)), null);
  }

  /** No terms: explicit item priorities, else input order. */
  public static Priority none() {
    return new Priority(List.of(), null);
  }

  /** A numeric item attribute ({@code attrs.<name>}); items without it score 0 after normalization. */
  public static Priority attr(String name) {
    return term("attr", Objects.requireNonNull(name, "name"));
  }

  /** An expression of the expression language, e.g. {@code "attrs.cbo * 2 + attrs.loc"}. */
  public static Priority expr(String expression) {
    return term("expr", Objects.requireNonNull(expression, "expression"));
  }

  /** A built-in measure. */
  public static Priority builtin(Builtin builtin) {
    return term("builtin", builtin);
  }

  /** Outlierness with the default neighbour count (5). */
  public static Priority outlierness() {
    return builtin(Builtin.OUTLIERNESS);
  }

  /** Outlierness over the {@code k} nearest neighbours. */
  public static Priority outlierness(int k) {
    return outlierness().k(k);
  }

  /** Isolation (free space around the item). */
  public static Priority isolation() {
    return builtin(Builtin.ISOLATION);
  }

  /** Crowding (local density). */
  public static Priority crowding() {
    return builtin(Builtin.CROWDING);
  }

  /** Label size. */
  public static Priority labelSize() {
    return builtin(Builtin.LABEL_SIZE);
  }

  /** Mark size. */
  public static Priority markSize() {
    return builtin(Builtin.MARK_SIZE);
  }

  /** Closeness to the focus point. */
  public static Priority centrality() {
    return builtin(Builtin.CENTRALITY);
  }

  /** Graph degree. */
  public static Priority degree() {
    return builtin(Builtin.DEGREE);
  }

  /** Input order. */
  public static Priority inputOrder() {
    return builtin(Builtin.INPUT_ORDER);
  }

  /**
   * A score computed in Java for every item without an explicit priority, evaluated when
   * the problem is built. Scores must be finite.
   */
  public static Priority callback(ToDoubleFunction<Item> score) {
    return new Priority(List.of(), Objects.requireNonNull(score, "score"));
  }

  /** Whether this priority is a Java callback. */
  public boolean isCallback() {
    return callback != null;
  }

  ToDoubleFunction<Item> callback() {
    return callback;
  }

  /** The terms as JSON objects (empty for callbacks). */
  public List<Map<String, Object>> terms() {
    return terms;
  }

  private Priority single(String what, String key, Object value) {
    if (callback != null || terms.size() != 1) {
      throw new IllegalStateException(what + " applies to a single engine term; call it before plus()/minus()");
    }
    return new Priority(List.of(Spec.with(terms.get(0), key, value)), null);
  }

  /** Transform raw values with {@code ln(1 + v)}. */
  public Priority log1p() {
    return transform(Transform.LOG1P);
  }

  /** Transform raw values with the square root. */
  public Priority sqrt() {
    return transform(Transform.SQRT);
  }

  /** Negate raw values (reverses the order). */
  public Priority neg() {
    return transform(Transform.NEG);
  }

  /** Absolute raw values. */
  public Priority abs() {
    return transform(Transform.ABS);
  }

  /** A transform of the raw values. */
  public Priority transform(Transform transform) {
    return single("transform", "transform", transform);
  }

  /** Normalization across items. */
  public Priority normalize(Normalize normalize) {
    return single("normalize", "normalize", normalize);
  }

  /** The term weight (default 1). */
  public Priority weight(double weight) {
    return single("weight", "weight", weight);
  }

  /** Neighbour count of {@code outlierness}. */
  public Priority k(int k) {
    return single("k", "k", k);
  }

  /** Scale every term weight (or the callback's score) by {@code factor}. */
  public Priority times(double factor) {
    if (callback != null) {
      ToDoubleFunction<Item> f = callback;
      return new Priority(List.of(), item -> factor * f.applyAsDouble(item));
    }
    List<Map<String, Object>> out = new ArrayList<>(terms.size());
    for (Map<String, Object> t : terms) {
      double w = t.get("weight") instanceof Number n ? n.doubleValue() : 1.0;
      out.add(Spec.with(t, "weight", w * factor));
    }
    return new Priority(Collections.unmodifiableList(out), null);
  }

  /** The sum of both priorities. */
  public Priority plus(Priority other) {
    Objects.requireNonNull(other, "other");
    if ((callback != null) != (other.callback != null)) {
      if (callback == null && terms.isEmpty()) {
        return other;
      }
      if (other.callback == null && other.terms.isEmpty()) {
        return this;
      }
      throw new IllegalArgumentException(
          "a callback priority combines with other callbacks only, not with engine terms");
    }
    if (callback != null) {
      ToDoubleFunction<Item> f = callback;
      ToDoubleFunction<Item> g = other.callback;
      return new Priority(List.of(), item -> f.applyAsDouble(item) + g.applyAsDouble(item));
    }
    List<Map<String, Object>> out = new ArrayList<>(terms);
    out.addAll(other.terms);
    return new Priority(Collections.unmodifiableList(out), null);
  }

  /** This priority minus {@code other} (its weights negated). */
  public Priority minus(Priority other) {
    return plus(other.times(-1));
  }

  /** The {@code priority.terms} JSON array. */
  public String toJson() {
    if (callback != null) {
      throw new IllegalStateException("a callback priority has no JSON form");
    }
    return Json.write(terms);
  }

  @Override
  public String toString() {
    return callback != null ? "Priority[callback]" : "Priority" + toJson();
  }
}
