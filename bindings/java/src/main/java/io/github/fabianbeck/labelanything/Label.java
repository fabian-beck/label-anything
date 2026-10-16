package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * What is placed next to an item (spec §5.1): text, an icon or box of a given size, or a
 * composite of those in a row or column.
 *
 * <pre>{@code
 * Label.text("org.example.Foo").wrap(Wrap.width(60).maxLines(2)).truncate(Truncate.END)
 * Label.icon(16, 16).rounded(3)
 * Label.composite(Label.icon(12, 12), Label.text("Server A")).gap(3)
 * }</pre>
 */
public abstract sealed class Label extends Spec {
  Label(Map<String, Object> json) {
    super(json);
  }

  /** Alignment of wrapped lines or composite parts. */
  public enum Align implements JsonName {
    START,
    CENTER,
    END;

    @Override
    public String jsonName() {
      return JsonName.lower(this);
    }
  }

  /** A text label. */
  public static Text text(String text) {
    return new Text(obj("type", "text", "text", text));
  }

  /**
   * A text label measured by the host: the engine uses this box size instead of measuring
   * (the lines are reported back).
   */
  public static Text measured(double width, double height, String... lines) {
    Text t = new Text(obj("type", "text", "width", width, "height", height));
    return lines.length == 0 ? t : t.lines(lines);
  }

  /** An icon of {@code width × height} px. */
  public static Sized icon(double width, double height) {
    return new Sized(obj("type", "icon", "width", width, "height", height));
  }

  /** A box of {@code width × height} px (e.g. a sparkline or a mini chart). */
  public static Sized box(double width, double height) {
    return new Sized(obj("type", "box", "width", width, "height", height));
  }

  /** Text and sized parts laid out in a row (see {@link Composite#column()}). */
  public static Composite composite(Label... parts) {
    if (parts.length == 0) {
      throw new IllegalArgumentException("a composite label needs at least one part");
    }
    List<Object> list = new ArrayList<>();
    for (Label p : parts) {
      if (p instanceof Composite) {
        throw new IllegalArgumentException("composite labels cannot be nested");
      }
      list.add(p.json);
    }
    return new Composite(obj("type", "composite", "parts", list));
  }

  /** A label from its JSON object (as built by this class). */
  static Label fromJson(Map<String, Object> json) {
    Object type = json.get("type");
    if ("composite".equals(type)) {
      return new Composite(json);
    }
    if ("icon".equals(type) || "box".equals(type)) {
      return new Sized(json);
    }
    return new Text(json);
  }

  /** The label text ({@code null} for icons, boxes and composites). */
  public String text() {
    return json.get("text") instanceof String s ? s : null;
  }

  /** A text label. */
  public static final class Text extends Label {
    Text(Map<String, Object> json) {
      super(json);
    }

    private Text with(String key, Object value) {
      return new Text(Spec.with(json, key, value));
    }

    /** Shorter fallbacks, in order of preference (the {@code alternatives} ladder step). */
    public Text alternatives(String... alternatives) {
      return with("alternatives", Arrays.asList(alternatives));
    }

    /** Wrapping settings ({@code null} for none). */
    public Text wrap(Wrap wrap) {
      return with("wrap", wrap == null ? null : wrap.json);
    }

    /** Truncation of wrapped text that exceeds its line limit. */
    public Text truncate(Truncate truncate) {
      return with("truncate", truncate);
    }

    /** Font settings of this label. */
    public Text font(Font font) {
      return with("font", font);
    }

    /** Font size of this label in px (merged into its font settings). */
    public Text fontSize(double size) {
      Object f = json.get("font");
      @SuppressWarnings("unchecked")
      Map<String, Object> font = f instanceof Map ? (Map<String, Object>) f : Map.of();
      return with("font", Spec.with(font, "size", size));
    }

    /** Box inflation around the text in px. */
    public Text padding(double px) {
      return with("padding", len(px));
    }

    /** Box inflation around the text with a unit ({@code "0.2em"}). */
    public Text padding(String length) {
      return with("padding", len(length));
    }

    /** Host-measured size in px (disables built-in measurement for this label). */
    public Text size(double width, double height) {
      return with("width", width).with("height", height);
    }

    /** Host-wrapped lines matching {@link #size(double, double)}. */
    public Text lines(String... lines) {
      return with("lines", Arrays.asList(lines));
    }

    /** Alignment of wrapped lines inside the box (reported only). */
    public Text align(Align align) {
      return with("align", align);
    }
  }

  /** An icon or a box of fixed size. */
  public static final class Sized extends Label {
    Sized(Map<String, Object> json) {
      super(json);
    }

    private Sized with(String key, Object value) {
      return new Sized(Spec.with(json, key, value));
    }

    /** Rectangular silhouette (default). */
    public Sized rect() {
      return with("shape", "rect");
    }

    /** Circular silhouette. */
    public Sized circle() {
      return with("shape", "circle");
    }

    /** Rounded rectangle with corner radius {@code r} px. */
    public Sized rounded(double r) {
      if (!(r >= 0) || Double.isInfinite(r)) {
        throw new IllegalArgumentException("corner radius must be >= 0");
      }
      return with("shape", "rounded:" + plainNumber(r));
    }

    /** Polygon silhouette relative to the top-left corner. */
    public Sized polygon(double[][] silhouette) {
      return with("shape", "polygon").with("polygon", points(silhouette, 3, "polygon"));
    }

    /** Box inflation in px. */
    public Sized padding(double px) {
      return with("padding", len(px));
    }

    /** Box inflation with a unit. */
    public Sized padding(String length) {
      return with("padding", len(length));
    }

    /** Font (only used to resolve {@code em} units). */
    public Sized font(Font font) {
      return with("font", font);
    }
  }

  /** Parts laid out in a row (default) or column. */
  public static final class Composite extends Label {
    Composite(Map<String, Object> json) {
      super(json);
    }

    private Composite with(String key, Object value) {
      return new Composite(Spec.with(json, key, value));
    }

    /** Parts side by side. */
    public Composite row() {
      return with("direction", "row");
    }

    /** Parts stacked. */
    public Composite column() {
      return with("direction", "column");
    }

    /** Gap between parts in px. */
    public Composite gap(double px) {
      return with("gap", len(px));
    }

    /** Gap between parts with a unit. */
    public Composite gap(String length) {
      return with("gap", len(length));
    }

    /** Cross-axis alignment of the parts. */
    public Composite align(Align align) {
      return with("align", align);
    }

    /** Box inflation in px. */
    public Composite padding(double px) {
      return with("padding", len(px));
    }

    /** Box inflation with a unit. */
    public Composite padding(String length) {
      return with("padding", len(length));
    }

    /** Font of the text parts. */
    public Composite font(Font font) {
      return with("font", font);
    }
  }
}
