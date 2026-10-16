package io.github.fabianbeck.labelanything;

import java.util.Map;

/**
 * Leader line options (spec §7). Leaders never cross other leaders or pass through labels
 * by default (see {@link Avoid#leader()}).
 *
 * <pre>{@code
 * Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315).port(Leaders.Port.SIDE_CENTER)
 * Leaders.orthogonal().clearance(4)
 * }</pre>
 */
public final class Leaders extends Spec {
  private Leaders(Map<String, Object> json) {
    super(json);
  }

  /** Where a leader meets its label. */
  public enum Port implements JsonName {
    /** The point of the label box closest to the leader (default). */
    NEAREST,
    /** The midpoint of the side facing the anchor. */
    SIDE_CENTER,
    /** The end of an underline below the first text line. */
    BASELINE;

    @Override
    public String jsonName() {
      return JsonName.hyphen(this);
    }
  }

  /** Where a leader starts at the item. */
  public enum Attach implements JsonName {
    /** Boundary, or the tip for icon marks (default). */
    AUTO,
    BOUNDARY,
    CENTER,
    TIP;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** No settings: the defaults (straight leaders). */
  public static Leaders defaults() {
    return new Leaders(Map.of());
  }

  /** A leader style. */
  public static Leaders style(LeaderStyle style) {
    return new Leaders(obj("style", style));
  }

  /** One straight segment (default). */
  public static Leaders straight() {
    return style(LeaderStyle.STRAIGHT);
  }

  /** Straight leaders restricted to these directions (degrees, 0 = right, 90 = up). */
  public static Leaders angles(double... degrees) {
    return style(LeaderStyle.ANGLES).with("angles", degrees);
  }

  /** Horizontal and vertical segments. */
  public static Leaders orthogonal() {
    return style(LeaderStyle.ORTHOGONAL);
  }

  /** A first segment at one of these angles, then horizontal into the label. */
  public static Leaders elbow(double... degrees) {
    Leaders l = style(LeaderStyle.ELBOW);
    return degrees.length == 0 ? l : l.with("angles", degrees);
  }

  /** Quadratic Bezier curves. */
  public static Leaders curved() {
    return style(LeaderStyle.CURVED);
  }

  private Leaders with(String key, Object value) {
    return new Leaders(Spec.with(json, key, value));
  }

  /** Where the leader meets the label. */
  public Leaders port(Port port) {
    return with("port", port);
  }

  /** Where the leader starts at the item. */
  public Leaders attach(Attach attach) {
    return with("attach", attach);
  }

  /** Shorter leaders are not drawn, in px (default 6). */
  public Leaders minLength(double px) {
    return with("min_length", len(px));
  }

  /** Shorter leaders are not drawn ({@code "4pt"}). */
  public Leaders minLength(String length) {
    return with("min_length", len(length));
  }

  /** Longest leader in px (default 10 em). */
  public Leaders maxLength(double px) {
    return with("max_length", len(px));
  }

  /** Longest leader ({@code "12em"}). */
  public Leaders maxLength(String length) {
    return with("max_length", len(length));
  }

  /** Gap between the mark boundary and the leader start in px (default 1.5). */
  public Leaders anchorGap(double px) {
    return with("anchor_gap", len(px));
  }

  /** Gap between the mark boundary and the leader start. */
  public Leaders anchorGap(String length) {
    return with("anchor_gap", len(length));
  }

  /** Clearance from other items and leaders in px (default 3). */
  public Leaders clearance(double px) {
    return with("clearance", len(px));
  }

  /** Clearance from other items and leaders. */
  public Leaders clearance(String length) {
    return with("clearance", len(length));
  }

  /** Nearby leaders differ at least this much in direction, degrees 0–90 (default 10). */
  public Leaders minAngleBetween(double degrees) {
    return with("min_angle_between", degrees);
  }

  /** Stroke width used for collision tests in px (default 1). */
  public Leaders width(double px) {
    return with("width", px);
  }
}
