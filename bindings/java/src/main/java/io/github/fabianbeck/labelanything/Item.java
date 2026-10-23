package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * One labeled feature: an anchor (a point with a mark, or an area polygon), its label and
 * the data that drives priority (attrs, explicit priority, tier, required, group,
 * keep-with). Immutable; build it with {@link #point(String, double, double)} or {@link
 * #area(String, double[][])}.
 *
 * <pre>{@code
 * Item.point("berlin", 120, 80).label(Label.text("Berlin"))
 *     .mark(Mark.circle(4)).attr("population", 3_850_000).tier(1)
 * }</pre>
 *
 * <p>Instances passed to a {@link Priority#callback priority callback} know their {@link
 * #index()} in the problem.
 */
public final class Item extends Spec {
  private final int index;

  Item(Map<String, Object> json, int index) {
    super(json);
    this.index = index;
  }

  /** A point anchor at {@code (x, y)} (input coordinates); {@code id} may be null. */
  public static Builder point(String id, double x, double y) {
    return new Builder(id, obj("type", "point", "x", x, "y", y));
  }

  /** A point anchor without id (the engine uses the item's index). */
  public static Builder point(double x, double y) {
    return point(null, x, y);
  }

  /** An area anchor: a polygon {@code {{x, y}, ...}} labeled inside when the label fits. */
  public static Builder area(String id, double[][] polygon) {
    return new Builder(id, obj("type", "area", "polygon", points(polygon, 3, "area polygon")));
  }

  Item withIndex(int i) {
    return i == index ? this : new Item(json, i);
  }

  Item withJson(String key, Object value) {
    return new Item(Spec.with(json, key, value), index);
  }

  /** The id, or {@code null} when the engine assigns the index as id. */
  public String id() {
    return json.get("id") instanceof String s ? s : null;
  }

  /** Position in the problem's item list ({@code -1} before the item is added). */
  public int index() {
    return index;
  }

  /** Whether the anchor is an area polygon. */
  public boolean isArea() {
    return "area".equals(anchor().get("type"));
  }

  /** Anchor x in input coordinates ({@code NaN} for areas). */
  public double x() {
    return anchor().get("x") instanceof Number n ? n.doubleValue() : Double.NaN;
  }

  /** Anchor y in input coordinates ({@code NaN} for areas). */
  public double y() {
    return anchor().get("y") instanceof Number n ? n.doubleValue() : Double.NaN;
  }

  /** The label. */
  public Label label() {
    return Label.fromJson(map(json.get("label")));
  }

  /** The label text ({@code null} for non-text labels). */
  public String text() {
    return map(json.get("label")).get("text") instanceof String s ? s : null;
  }

  /** Free data for priority terms, expressions and callbacks. */
  public Map<String, Object> attrs() {
    return map(json.get("attrs"));
  }

  /** One attribute ({@code null} if absent). */
  public Object attr(String name) {
    return attrs().get(name);
  }

  /** A numeric attribute, or {@code fallback} when it is absent or not a number. */
  public double attr(String name, double fallback) {
    return attr(name) instanceof Number n ? n.doubleValue() : fallback;
  }

  /** The explicit priority score, or {@code null}. */
  public Double priority() {
    return json.get("priority") instanceof Number n ? n.doubleValue() : null;
  }

  /** The explicit tier, or {@code null}. */
  public Integer tier() {
    return json.get("tier") instanceof Number n ? n.intValue() : null;
  }

  /** Whether the item is required. */
  public boolean required() {
    return Boolean.TRUE.equals(json.get("required"));
  }

  /** The group id, or {@code null}. */
  public String group() {
    return json.get("group") instanceof String s ? s : null;
  }

  private Map<String, Object> anchor() {
    return map(json.get("anchor"));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : Map.of();
  }

  /** Builder of an {@link Item}. */
  public static final class Builder {
    private final Map<String, Object> m = new LinkedHashMap<>();
    private Map<String, Object> anchor;
    private final Map<String, Object> attrs = new LinkedHashMap<>();

    private Builder(String id, Map<String, Object> anchor) {
      if (id != null) {
        if (id.isEmpty()) {
          throw new IllegalArgumentException("item ids must not be empty");
        }
        m.put("id", id);
      }
      this.anchor = anchor;
    }

    /** The label. */
    public Builder label(Label label) {
      m.put("label", Objects.requireNonNull(label, "label").json);
      return this;
    }

    /** The mark of a point anchor (default {@code defaults.mark}, a circle of radius 2). */
    public Builder mark(Mark mark) {
      requireAnchor("point", "mark");
      anchor = Spec.with(anchor, "mark", mark);
      return this;
    }

    /** Holes of an area polygon. */
    public Builder holes(double[][]... rings) {
      requireAnchor("area", "holes");
      List<Object> out = new ArrayList<>();
      for (double[][] r : rings) {
        out.add(points(r, 3, "hole"));
      }
      anchor = Spec.with(anchor, "holes", out);
      return this;
    }

    /** Mark drawn at the pole of an area when its label falls back to an external position. */
    public Builder dot(Mark dot) {
      requireAnchor("area", "dot");
      anchor = Spec.with(anchor, "dot", dot);
      return this;
    }

    /** One attribute (number, string, boolean, list or map). */
    public Builder attr(String name, Object value) {
      attrs.put(Objects.requireNonNull(name, "name"), plain(value));
      return this;
    }

    /** Several attributes. */
    public Builder attrs(Map<String, ?> values) {
      values.forEach(this::attr);
      return this;
    }

    /** Explicit priority score; overrides priority terms and callbacks for this item. */
    public Builder priority(double score) {
      m.put("priority", plain(score));
      return this;
    }

    /** Explicit tier; overrides priority tier rules for this item. */
    public Builder tier(int tier) {
      m.put("tier", tier);
      return this;
    }

    /** Required items outrank everything and are never omitted while others are placed. */
    public Builder required() {
      return required(true);
    }

    /** Whether the item is required. */
    public Builder required(boolean required) {
      m.put("required", required);
      return this;
    }

    /** Items sharing a group id share one label with fan leaders. */
    public Builder group(String group) {
      m.put("group", group);
      return this;
    }

    /** All-or-none set: every item naming the same set is placed or omitted together. */
    public Builder keepWith(String setName) {
      m.put("keep_with", setName);
      return this;
    }

    /** All-or-none with the listed item ids. */
    public Builder keepWithItems(String... itemIds) {
      m.put("keep_with", Collections.unmodifiableList(Arrays.asList(itemIds.clone())));
      return this;
    }

    /**
     * The item's home region (spec §4.8), when it is not the region under its anchor: its
     * label keeps to it.
     */
    public Builder region(String region) {
      m.put("region", region);
      return this;
    }

    /** Id of the background SVG element that draws this item. */
    public Builder svgId(String svgId) {
      m.put("svg_id", svgId);
      return this;
    }

    /**
     * Per-item placement options: only {@code models}, {@code offset}, {@code internal} and
     * {@code positionOrder}/{@code positions} apply.
     */
    public Builder placement(Placement placement) {
      m.put("placement", placement.json);
      return this;
    }

    /** The item. */
    public Item build() {
      if (!m.containsKey("label")) {
        throw new IllegalStateException("item " + m.getOrDefault("id", "") + " has no label");
      }
      Map<String, Object> out = new LinkedHashMap<>();
      if (m.containsKey("id")) {
        out.put("id", m.get("id"));
      }
      out.put("anchor", anchor);
      out.put("label", m.get("label"));
      if (!attrs.isEmpty()) {
        out.put("attrs", Collections.unmodifiableMap(new LinkedHashMap<>(attrs)));
      }
      for (Map.Entry<String, Object> e : m.entrySet()) {
        out.putIfAbsent(e.getKey(), e.getValue());
      }
      return new Item(Collections.unmodifiableMap(out), -1);
    }

    private void requireAnchor(String type, String what) {
      if (!type.equals(anchor.get("type"))) {
        throw new IllegalStateException(what + " applies to " + type + " anchors only");
      }
    }
  }
}
