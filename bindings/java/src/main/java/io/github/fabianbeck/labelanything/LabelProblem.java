package io.github.fabianbeck.labelanything;

import io.github.fabianbeck.labelanything.json.Json;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.ToDoubleFunction;

/**
 * A label placement problem (problem.v1): items with anchors and labels, backgrounds, the
 * avoidance policy and the options. Immutable; create it with {@link #builder()}.
 *
 * <pre>{@code
 * var problem = LabelProblem.builder()
 *     .canvas(800, 600).fontSize(12)
 *     .item("A", 120, 80, Label.text("Alpha"))
 *     .backgroundRaster(Path.of("map.png"), RasterMode.INK)
 *     .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
 *     .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
 *     .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
 *     .omission(Omission.STRICT)
 *     .build();
 * }</pre>
 *
 * <p>When the first raster background is raw pixels ({@link Raster#pixels}), the pixels
 * travel to the native library through the zero-copy pointer entry point and {@link
 * #toJson()} carries only the raster's options and size; {@link #toPortableJson()} embeds
 * the pixels as base64 so the JSON is self-contained (e.g. for the CLI).
 */
public final class LabelProblem {
  private static final List<String> KEY_ORDER = List.of(
      "$schema", "version", "canvas", "y_axis", "transform", "preset", "defaults", "text",
      "items", "obstacles", "avoid", "placement", "leaders", "priority", "solver", "degrade",
      "degrade_options", "weights", "warm_start", "output");

  private final Map<String, Object> root;
  private final List<Item> items;
  private final Raster pointerRaster;
  private final String json;
  private volatile String portableJson;

  private LabelProblem(Map<String, Object> root, List<Item> items, Raster pointerRaster) {
    this.root = root;
    this.items = items;
    this.pointerRaster = pointerRaster;
    this.json = Json.write(root);
  }

  /** A new builder. */
  public static Builder builder() {
    return new Builder();
  }

  /** The problem JSON as sent to the engine. */
  public String toJson() {
    return json;
  }

  /**
   * Self-contained problem JSON: identical to {@link #toJson()} except that pixels passed
   * by pointer are embedded as base64 {@code rgba}. Use it with the CLI or other bindings.
   */
  public String toPortableJson() {
    if (pointerRaster == null) {
      return json;
    }
    String p = portableJson;
    if (p == null) {
      Map<String, Object> copy = new LinkedHashMap<>(root);
      Map<String, Object> obstacles = new LinkedHashMap<>(Parse.map(copy.get("obstacles")));
      Object raster = obstacles.get("raster");
      if (raster instanceof List<?> list) {
        List<Object> l = new ArrayList<>(list);
        l.set(0, pointerRaster.embeddedJson());
        obstacles.put("raster", l);
      } else {
        obstacles.put("raster", pointerRaster.embeddedJson());
      }
      copy.put("obstacles", obstacles);
      p = Json.write(copy);
      portableJson = p;
    }
    return p;
  }

  /** The problem as an unmodifiable JSON tree (maps, lists, strings, numbers, booleans). */
  public Map<String, Object> toMap() {
    return root;
  }

  /** The items, in input order (with their {@link Item#index()}). */
  public List<Item> items() {
    return items;
  }

  /** Pixels for the pointer entry point, or null. */
  Pixels pointerPixels() {
    return pointerRaster == null ? null : pointerRaster.pixels;
  }

  @Override
  public String toString() {
    return "LabelProblem[items=" + items.size() + "]";
  }

  /**
   * Builder of a {@link LabelProblem}. Options mirror the problem schema
   * ({@code spec/schema/problem.v1.json}); unset options keep the engine defaults
   * ({@code spec/defaults.md}). {@link #option(String, Object)} sets any other option.
   */
  public static final class Builder {
    private final Map<String, Object> root = new LinkedHashMap<>();
    private final List<Item> items = new ArrayList<>();
    private final List<Raster> rasters = new ArrayList<>();
    private final List<Object> svgs = new ArrayList<>();
    private final List<Object> vectors = new ArrayList<>();
    private ToDoubleFunction<Item> priorityCallback;

    private Builder() {}

    // ---------------------------------------------------------------------------------
    // tree helpers
    // ---------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> child(Map<String, Object> parent, String key) {
      Object c = parent.get(key);
      if (c instanceof LinkedHashMap) {
        return (Map<String, Object>) c;
      }
      Map<String, Object> m = new LinkedHashMap<>();
      if (c instanceof Map<?, ?> old) {
        old.forEach((k, v) -> m.put(String.valueOf(k), v));
      }
      parent.put(key, m);
      return m;
    }

    /** The (mutable) object at a dotted path, created as needed. */
    private Map<String, Object> at(String dottedPath) {
      Map<String, Object> m = root;
      for (String key : dottedPath.split("\\.")) {
        m = child(m, key);
      }
      return m;
    }

    private Builder put(String dottedPath, Object value) {
      int dot = dottedPath.lastIndexOf('.');
      String parent = dot < 0 ? null : dottedPath.substring(0, dot);
      String last = dottedPath.substring(dot + 1);
      if (value == null) {
        // remove without creating empty parents
        Map<String, Object> m = root;
        if (parent != null) {
          for (String key : parent.split("\\.")) {
            if (!(m.get(key) instanceof Map)) {
              return this;
            }
            m = child(m, key);
          }
        }
        m.remove(last);
        return this;
      }
      Map<String, Object> m = parent == null ? root : at(parent);
      m.put(last, Spec.plain(value));
      return this;
    }

    @SuppressWarnings("unchecked")
    private static void deepMerge(Map<String, Object> target, Map<String, Object> source) {
      for (Map.Entry<String, Object> e : source.entrySet()) {
        Object old = target.get(e.getKey());
        if (old instanceof Map && e.getValue() instanceof Map) {
          deepMerge(child(target, e.getKey()), (Map<String, Object>) e.getValue());
        } else {
          target.put(e.getKey(), e.getValue());
        }
      }
    }

    private Builder merge(String dottedPath, Map<String, Object> fragment) {
      deepMerge(at(dottedPath), fragment);
      return this;
    }

    /**
     * Set any option by its dotted path in the problem JSON, e.g. {@code
     * option("placement.k_distant", 12)} or {@code option("output.item_shape", true)}. The
     * value may be a number, string, boolean, list, map, enum or option object; {@code null}
     * removes the option.
     */
    public Builder option(String dottedPath, Object value) {
      return put(Objects.requireNonNull(dottedPath, "dottedPath"), value);
    }

    // ---------------------------------------------------------------------------------
    // canvas and coordinates
    // ---------------------------------------------------------------------------------

    /** Canvas size in px. */
    public Builder canvas(double width, double height) {
      return put("canvas.width", width).put("canvas.height", height);
    }

    /** Keep labels this far inside the canvas in px (default 4). */
    public Builder canvasPadding(double px) {
      return put("canvas.padding", px);
    }

    /** Keep labels this far inside the canvas ({@code "0.5em"}). */
    public Builder canvasPadding(String length) {
      return put("canvas.padding", length);
    }

    /** Allow labels outside the canvas. */
    public Builder allowOutside(boolean allow) {
      return put("canvas.allow_outside", allow);
    }

    /** Sub-rectangle labels must stay inside (leaders may leave it). */
    public Builder region(double x, double y, double w, double h) {
      return put("canvas.region", new double[] {x, y, w, h});
    }

    /**
     * Colour of the canvas where no raster lies ({@code "#rrggbb"}, default white): the
     * backdrop of the labels there for the {@code contrast} cost term.
     */
    public Builder canvasBackground(String color) {
      return put("canvas.background", color);
    }

    /** Informational device pixel ratio. */
    public Builder devicePixelRatio(double ratio) {
      return put("canvas.device_pixel_ratio", ratio);
    }

    /** Input y grows upwards (y_px = canvas height − y, after the transform). */
    public Builder yAxisUp() {
      return put("y_axis", "up");
    }

    /** Affine data → pixel map {@code [a, b, c, d, e, f]} (SVG matrix order). */
    public Builder transform(double a, double b, double c, double d, double e, double f) {
      return put("transform", new double[] {a, b, c, d, e, f});
    }

    /** A bundle of defaults. */
    public Builder preset(Preset preset) {
      return put("preset", preset);
    }

    // ---------------------------------------------------------------------------------
    // label defaults
    // ---------------------------------------------------------------------------------

    /** Default font size in px (default 12). */
    public Builder fontSize(double size) {
      return put("defaults.font.size", size);
    }

    /** Default font settings (merged with earlier settings). */
    public Builder font(Font font) {
      return merge("defaults.font", font.json);
    }

    /** Default label box inflation in px (default 0.15 em). */
    public Builder labelPadding(double px) {
      return put("defaults.padding", px);
    }

    /** Default label box inflation ({@code "0.15em"}). */
    public Builder labelPadding(String length) {
      return put("defaults.padding", length);
    }

    /** Soft ambiguity buffer around labels in px (default 0.3 em). */
    public Builder buffer(double px) {
      return put("defaults.buffer", px);
    }

    /** Soft ambiguity buffer around labels ({@code "0.3em"}). */
    public Builder buffer(String length) {
      return put("defaults.buffer", length);
    }

    /** Space labels keep from other labels and other marks, in px (default 0.2 em). */
    public Builder margin(double px) {
      return put("defaults.margin", px);
    }

    /** Space labels keep from other labels and other marks ({@code "0.2em"}). */
    public Builder margin(String length) {
      return put("defaults.margin", length);
    }

    /** Mark of point anchors without their own mark (default circle r = 2). */
    public Builder defaultMark(Mark mark) {
      return put("defaults.mark", mark);
    }

    /** Default wrapping of text labels ({@code null}: single line). */
    public Builder wrap(Wrap wrap) {
      return put("defaults.wrap", wrap == null ? null : wrap.json);
    }

    /** Default truncation of wrapped text. */
    public Builder truncate(Truncate truncate) {
      return put("defaults.truncate", truncate);
    }

    /** Text shaping mode. */
    public Builder textShaping(Shaping shaping) {
      return put("text.shaping", shaping);
    }

    // ---------------------------------------------------------------------------------
    // items
    // ---------------------------------------------------------------------------------

    /** Add an item. */
    public Builder item(Item item) {
      items.add(Objects.requireNonNull(item, "item"));
      return this;
    }

    /** Add an item. */
    public Builder item(Item.Builder item) {
      return item(item.build());
    }

    /** Add a point item with the default mark. */
    public Builder item(String id, double x, double y, Label label) {
      return item(Item.point(id, x, y).label(label));
    }

    /**
     * Add a point item and set more of its properties, e.g. {@code
     * item("A", 1, 2, Label.text("A"), it -> it.mark(Mark.circle(4)).attr("traffic", 3))}.
     */
    public Builder item(String id, double x, double y, Label label, Consumer<Item.Builder> more) {
      Item.Builder b = Item.point(id, x, y).label(label);
      more.accept(b);
      return item(b);
    }

    /** Add an area item (labeled inside its polygon when the label fits). */
    public Builder area(String id, double[][] polygon, Label label) {
      return item(Item.area(id, polygon).label(label));
    }

    /** Add items. */
    public Builder items(Iterable<Item> items) {
      items.forEach(this::item);
      return this;
    }

    // ---------------------------------------------------------------------------------
    // backgrounds
    // ---------------------------------------------------------------------------------

    /** Add a raster background. */
    public Builder background(Raster raster) {
      rasters.add(Objects.requireNonNull(raster, "raster"));
      return this;
    }

    /** Add an SVG background. */
    public Builder background(Svg svg) {
      svgs.add(svg.json);
      return this;
    }

    /** Add a raster background from an image file (PNG, JPEG, WebP). */
    public Builder backgroundRaster(Path image) {
      return background(Raster.file(image));
    }

    /** Add a raster background from an image file with a pixel mode. */
    public Builder backgroundRaster(Path image, RasterMode mode) {
      return background(Raster.file(image).mode(mode));
    }

    /** Add a raster background from encoded image bytes (PNG, JPEG, WebP). */
    public Builder backgroundRaster(byte[] encodedImage, RasterMode mode) {
      return background(Raster.encoded(encodedImage).mode(mode));
    }

    /**
     * Add a raster background of raw RGBA8 pixels; a direct buffer is passed to the native
     * library in place (zero-copy) when this is the first raster.
     */
    public Builder backgroundPixels(int width, int height, ByteBuffer rgba, RasterMode mode) {
      return background(Raster.pixels(width, height, rgba).mode(mode));
    }

    /** Add a raster background of raw RGBA8 pixels from an array. */
    public Builder backgroundPixels(int width, int height, byte[] rgba, RasterMode mode) {
      return background(Raster.pixels(width, height, rgba).mode(mode));
    }

    /** Add an SVG background from markup. */
    public Builder backgroundSvg(String markup) {
      return background(Svg.markup(markup));
    }

    /** Add an SVG background from a file. */
    public Builder backgroundSvg(Path svg) {
      return background(Svg.file(svg));
    }

    /** Add a layer of vector obstacles. */
    public Builder vector(VectorLayer layer) {
      vectors.add(layer.json);
      return this;
    }

    // ---------------------------------------------------------------------------------
    // policy and options
    // ---------------------------------------------------------------------------------

    /** Merge avoidance settings (key by key over the defaults). */
    public Builder avoid(Avoid... settings) {
      for (Avoid a : settings) {
        if (a.section.equals("relaxable")) {
          put("avoid.relaxable", a.json.get("relaxable"));
        } else {
          merge("avoid." + a.section, a.json);
        }
      }
      return this;
    }

    /** Leader options (merged with earlier settings). */
    public Builder leaders(Leaders leaders) {
      return merge("leaders", leaders.json);
    }

    /** Candidate options (merged with earlier settings). */
    public Builder placement(Placement placement) {
      return merge("placement", placement.json);
    }

    /** Cost weights (merged with earlier settings). */
    public Builder weights(Weights weights) {
      return merge("weights", weights.json);
    }

    /**
     * The priority score: engine terms ({@code priority.terms}), or a Java callback that
     * writes explicit priorities into the items when the problem is built. Replaces an
     * earlier priority.
     */
    public Builder priority(Priority priority) {
      if (priority.isCallback()) {
        priorityCallback = priority.callback();
        return put("priority.terms", null);
      }
      priorityCallback = null;
      return put("priority.terms", priority.terms());
    }

    /** Add a tier rule: items matching the expression get {@code tier} (first match wins). */
    public Builder tier(String where, int tier) {
      Map<String, Object> pr = child(root, "priority");
      List<Object> tiers = new ArrayList<>(Parse.list(pr.get("tiers")));
      tiers.add(Spec.obj("where", where, "tier", tier));
      pr.put("tiers", Collections.unmodifiableList(tiers));
      return this;
    }

    /** Omission semantics. */
    public Builder omission(Omission omission) {
      return put("priority.omission", omission);
    }

    /** Keep at least {@code minPerGroup} labels per group of the expression {@code by}. */
    public Builder coverage(String by, int minPerGroup) {
      return put("priority.coverage", Spec.obj("by", by, "min_per_group", minPerGroup));
    }

    /** Tie-breaking rule of the priority order. */
    public Builder ties(Ties ties) {
      return put("priority.ties", ties);
    }

    /** Random tie-breaking with its own seed. */
    public Builder tiesRandom(long seed) {
      return put("priority.ties", "random(" + seed + ")");
    }

    /** Scores within {@code band} of each other form one equal-key band. */
    public Builder band(double band) {
      return put("priority.band", band);
    }

    /** Place at most this many labels, by priority order. */
    public Builder maxLabels(int maxLabels) {
      return put("priority.budget.max_labels", maxLabels);
    }

    /**
     * Type size by importance (spec §9.4): font classes over the total priority order, most
     * important first, e.g. {@code fontClasses(FontClass.share(5, 1.3).bold(),
     * FontClass.rest(0.9))}.
     */
    public Builder fontClasses(FontClass... classes) {
      return put("priority.font_classes", List.of(classes));
    }

    /** Cap on the canvas fraction covered by labels (0–1). */
    public Builder maxInkFraction(double fraction) {
      return put("priority.budget.max_ink_fraction", fraction);
    }

    /** Focus point of the {@code centrality} term (default: canvas center). */
    public Builder focus(double x, double y) {
      return put("priority.focus", new double[] {x, y});
    }

    /** Solver time budget in ms (converted to a deterministic iteration budget). */
    public Builder timeBudgetMs(double ms) {
      return put("solver.time_budget_ms", ms);
    }

    /** Seed of the PCG32 generator (0 – 2³²−1). */
    public Builder seed(long seed) {
      return put("solver.seed", seed);
    }

    /** Solver strategy. */
    public Builder strategy(Strategy strategy) {
      return put("solver.strategy", strategy);
    }

    /** Cap on local search iterations. */
    public Builder maxIterations(int iterations) {
      return put("solver.max_iterations", iterations);
    }

    /** Coverage grid cell size in px (default auto). */
    public Builder gridCell(double px) {
      return put("solver.grid_cell", px);
    }

    /** The degradation ladder, tried in order for items that do not fit. */
    public Builder degrade(Degrade... steps) {
      return degrade(Arrays.asList(steps));
    }

    /** The degradation ladder. */
    public Builder degrade(List<Degrade> steps) {
      return put("degrade", new ArrayList<Object>(steps));
    }

    /** Smallest font scale of shrink steps (default 0.7). */
    public Builder minScale(double scale) {
      return put("degrade_options.min_scale", scale);
    }

    /** Line limit of the wrap step for labels without wrap settings (default 3). */
    public Builder wrapMaxLines(int lines) {
      return put("degrade_options.wrap_max_lines", lines);
    }

    /** Weight replacing {@code hard} for classes relaxed by soft_overlap (default 10). */
    public Builder softOverlapWeight(double weight) {
      return put("degrade_options.soft_overlap_weight", weight);
    }

    /**
     * Stay close to a previous result (stability across frames): its boxes, with the anchors
     * they were placed for (boxes move with their items) and their leaders.
     */
    public Builder warmStart(LabelResult previous) {
      List<Object> placements = new ArrayList<>();
      for (LabelPlacement p : previous.placements()) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", p.id());
        m.put("placed", p.placed());
        if (p.box() != null) {
          m.put("box", Spec.obj("x", p.box().x(), "y", p.box().y(), "w", p.box().w(),
              "h", p.box().h()));
        }
        if (p.anchor() != null) {
          m.put("anchor", List.of(p.anchor().x(), p.anchor().y()));
        }
        Object leader = p.raw().get("leader");
        if (leader != null && !p.raw().containsKey("leaders")) {
          m.put("leader", leader);
        }
        placements.add(m);
      }
      return put("warm_start", Map.of("placements", placements));
    }

    /** Emit the debug SVG overlay in {@link LabelResult#debugSvg()}. */
    public Builder debugSvg(boolean enabled) {
      return put("output.debug_svg", enabled);
    }

    /** Report per-term costs of placed labels. */
    public Builder costBreakdown(boolean enabled) {
      return put("output.cost_breakdown", enabled);
    }

    /** Report all candidates in the result JSON. */
    public Builder reportCandidates(boolean enabled) {
      return put("output.candidates", enabled);
    }

    /** Echo resolved item geometry in the result JSON. */
    public Builder itemShape(boolean enabled) {
      return put("output.item_shape", enabled);
    }

    // ---------------------------------------------------------------------------------
    // build
    // ---------------------------------------------------------------------------------

    /**
     * The problem. A priority callback is evaluated here, once per item without an
     * explicit priority.
     *
     * @throws IllegalArgumentException if a priority callback returns a non-finite score
     */
    public LabelProblem build() {
      // items (with index, and callback priorities)
      List<Item> built = new ArrayList<>(items.size());
      List<Object> itemJson = new ArrayList<>(items.size());
      for (int i = 0; i < items.size(); i++) {
        Item item = items.get(i).withIndex(i);
        if (priorityCallback != null && item.priority() == null) {
          double score = priorityCallback.applyAsDouble(item);
          if (Double.isNaN(score) || Double.isInfinite(score)) {
            throw new IllegalArgumentException(
                "priority callback returned " + score + " for item " + i);
          }
          item = item.withJson("priority", score);
        }
        built.add(item);
        itemJson.add(item.json);
      }

      Map<String, Object> tree = new LinkedHashMap<>(root);
      tree.put("items", itemJson);

      // obstacles
      Raster pointer = null;
      if (!vectors.isEmpty() || !svgs.isEmpty() || !rasters.isEmpty()) {
        Map<String, Object> obstacles = new LinkedHashMap<>(Parse.map(tree.get("obstacles")));
        if (!vectors.isEmpty()) {
          obstacles.put("vector", new ArrayList<>(vectors));
        }
        if (!svgs.isEmpty()) {
          obstacles.put("svg", svgs.size() == 1 ? svgs.get(0) : new ArrayList<>(svgs));
        }
        if (!rasters.isEmpty()) {
          List<Object> list = new ArrayList<>();
          for (int i = 0; i < rasters.size(); i++) {
            Raster r = rasters.get(i);
            if (i == 0 && r.isPixels()) {
              pointer = r;
              list.add(r.pointerJson());
            } else {
              list.add(r.embeddedJson());
            }
          }
          obstacles.put("raster", list.size() == 1 ? list.get(0) : list);
        }
        tree.put("obstacles", obstacles);
      }

      Map<String, Object> ordered = new LinkedHashMap<>();
      for (String k : KEY_ORDER) {
        if (tree.containsKey(k)) {
          ordered.put(k, tree.get(k));
        }
      }
      tree.forEach(ordered::putIfAbsent);
      @SuppressWarnings("unchecked")
      Map<String, Object> frozen = (Map<String, Object>) Json.freeze(ordered);
      return new LabelProblem(frozen, Collections.unmodifiableList(built), pointer);
    }
  }
}
