package io.github.fabianbeck.labelanything;

import static io.github.fabianbeck.labelanything.TestSupport.assertSameJson;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.fabianbeck.labelanything.json.Json;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Builder output equals hand-written JSON (no native library needed). */
class BuilderJsonTest {
  @Test
  void briefExcerpt() {
    var problem = LabelProblem.builder()
        .canvas(800, 600).fontSize(12)
        .item("A", 120, 80, Label.text("Alpha"))
        .backgroundRaster(Path.of("map.png"), RasterMode.INK)
        .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
        .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
        .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
        .omission(Omission.STRICT)
        .build();
    String png = Json.write(Path.of("map.png").toAbsolutePath().toString());
    assertSameJson("""
        {
          "canvas": {"width": 800, "height": 600},
          "defaults": {"font": {"size": 12}},
          "items": [{"id": "A", "anchor": {"type": "point", "x": 120, "y": 80},
                     "label": {"type": "text", "text": "Alpha"}}],
          "obstacles": {"raster": {"source": %s, "mode": "ink"}},
          "avoid": {"label": {"labels": "hard", "ink": 0.5}},
          "leaders": {"style": "angles", "angles": [0, 45, 90, 135, 180, 225, 270, 315]},
          "priority": {"terms": [{"attr": "traffic", "transform": "log1p"},
                                 {"builtin": "outlierness", "k": 5}],
                       "omission": "strict"}
        }""".formatted(png), problem.toJson());
  }

  @Test
  void conformanceUnits() {
    var problem = LabelProblem.builder()
        .canvas(800, 600).canvasPadding("0.5em")
        .font(Font.of("default").size(14).bold().lineHeight(1.3))
        .labelPadding("2pt").buffer("0.25em")
        .item("u1", 400, 300, Label.text("Units everywhere").font(Font.ofSize(10).weight(400))
            .padding("1px"))
        .item("u2", 420, 310, Label.text("Bold label"))
        .placement(Placement.defaults().offset("3px").maxDistance("6em"))
        .leaders(Leaders.defaults().minLength("4pt").maxLength("12em").anchorGap("0.1em")
            .clearance("2px"))
        .build();
    assertSameJson(TestSupport.problem("units.json"), problem.toJson());
  }

  @Test
  void conformanceRegion() {
    var b = LabelProblem.builder()
        .canvas(600, 400).canvasPadding(2).region(50, 20, 520, 340);
    for (int i = 0; i < 10; i++) {
      b.item("e" + i, 55 + 50 * i, i % 2 == 0 ? 25 : 355, Label.text("Edge " + i));
    }
    var problem = b
        .vector(VectorLayer.of("axes").rect(50, 360, 520, 1).rect(50, 20, 1, 340))
        .avoid(Avoid.label().hard("axes"), Avoid.leader().ignore("axes"))
        .build();
    assertSameJson(TestSupport.problem("region.json"), problem.toJson());
  }

  @Test
  void conformanceIconsComposite() {
    var problem = LabelProblem.builder()
        .canvas(500, 300)
        .item("SEA", 120, 40, Label.icon(16, 16).rect())
        .item(Item.point("n17", 300, 150).mark(Mark.rect(30, 18).cornerRadius(4))
            .label(Label.composite(Label.icon(12, 12), Label.text("Server A")).row().gap(3)))
        .item("spark", 200, 220, Label.box(60, 14).rounded(3))
        .item("pin", 420, 120, Label.text("Café Central"),
            it -> it.mark(Mark.icon(14, 20).tip(7, 20)))
        .build();
    assertSameJson(TestSupport.problem("icons-composite.json"), problem.toJson());
  }

  @Test
  void conformanceElbowBoundary() {
    var b = LabelProblem.builder().canvas(700, 400).preset(Preset.ILLUSTRATION);
    for (int i = 0; i < 8; i++) {
      b.item("part" + i, 250 + 40 * (i % 4), i < 4 ? 100 : 150,
          Label.text("Part " + i + ": component"));
    }
    var problem = b
        .leaders(Leaders.elbow().port(Leaders.Port.SIDE_CENTER))
        .placement(Placement.models(Model.BOUNDARY)
            .boundarySides(Placement.Side.LEFT, Placement.Side.RIGHT)
            .boundaryAlign(Placement.BoundaryAlign.STACK).boundaryGap(4).boundaryMargin(8))
        .build();
    assertSameJson(TestSupport.problem("elbow-boundary.json"), problem.toJson());
  }

  @Test
  void itemsLabelsAndObstacles() {
    var problem = LabelProblem.builder()
        .canvas(400, 300).yAxisUp().transform(2, 0, 0, 2, 10, 10).preset(Preset.SCATTER)
        .defaultMark(Mark.circle(3)).wrap(Wrap.width("8em").maxLines(2)).truncate(Truncate.END)
        .textShaping(Shaping.SIMPLE)
        .item(Item.point("a", 1, 2).label(Label.text("Alpha").alternatives("A")
                .wrap(Wrap.lines(2).balance()).align(Label.Align.CENTER))
            .attr("cat", "x").attr("v", 3).priority(2).tier(1).required().group("g")
            .keepWith("set").svgId("node-a")
            .placement(Placement.models(Model.ADJACENT).positions(Placement.Position.TOP,
                Placement.Position.BOTTOM_LEFT).internal(Placement.Internal.NEVER)))
        .item(Item.point("b", 3, 4).label(Label.measured(30, 12, "Be", "ta"))
            .mark(Mark.ellipse(4, 2).rotation(30)).keepWithItems("a"))
        .area("lake", new double[][] {{0, 0}, {10, 0}, {10, 10}}, Label.text("Lake"))
        .item(Item.area("isle", new double[][] {{20, 20}, {30, 20}, {30, 30}})
            .holes(new double[][] {{22, 22}, {24, 22}, {24, 24}}).dot(Mark.circle(1))
            .label(Label.text("Isle")))
        .vector(VectorLayer.of("points").point(5, 5).points(new double[][] {{6, 6}}).r(2.5)
            .circle(7, 7, 1).polyline(0, 0, 10, 10).width(2)
            .polygon(new double[][] {{0, 0}, {1, 0}, {1, 1}})
            .fillRule(VectorLayer.FillRule.EVENODD).shape(Mark.rect(2, 2), 8, 8))
        .background(Svg.markup("<svg/>").classify(".o", "outliers").ignore("text")
            .defaultClass("ink").autoMarkItems().tolerance(0.5))
        .build();
    assertSameJson("""
        {
          "canvas": {"width": 400, "height": 300},
          "y_axis": "up",
          "transform": [2, 0, 0, 2, 10, 10],
          "preset": "scatter",
          "defaults": {"mark": {"shape": "circle", "r": 3},
                       "wrap": {"max_width": "8em", "max_lines": 2}, "truncate": "end"},
          "text": {"shaping": "simple"},
          "items": [
            {"id": "a", "anchor": {"type": "point", "x": 1, "y": 2},
             "label": {"type": "text", "text": "Alpha", "alternatives": ["A"],
                       "wrap": {"max_lines": 2, "balance": true}, "align": "center"},
             "attrs": {"cat": "x", "v": 3}, "priority": 2, "tier": 1, "required": true,
             "group": "g", "keep_with": "set", "svg_id": "node-a",
             "placement": {"models": ["adjacent"], "position_order": ["top", "bottom-left"],
                           "internal": "never"}},
            {"id": "b", "anchor": {"type": "point", "x": 3, "y": 4,
                                   "mark": {"shape": "ellipse", "rx": 4, "ry": 2, "rotation": 30}},
             "label": {"type": "text", "width": 30, "height": 12, "lines": ["Be", "ta"]},
             "keep_with": ["a"]},
            {"id": "lake", "anchor": {"type": "area", "polygon": [[0, 0], [10, 0], [10, 10]]},
             "label": {"type": "text", "text": "Lake"}},
            {"id": "isle", "anchor": {"type": "area", "polygon": [[20, 20], [30, 20], [30, 30]],
                                      "holes": [[[22, 22], [24, 22], [24, 24]]],
                                      "dot": {"shape": "circle", "r": 1}},
             "label": {"type": "text", "text": "Isle"}}
          ],
          "obstacles": {
            "vector": [{"class": "points", "points": [[5, 5], [6, 6]], "r": 2.5,
                        "circles": [[7, 7, 1]], "polylines": [[[0, 0], [10, 10]]], "width": 2,
                        "polygons": [[[0, 0], [1, 0], [1, 1]]], "fill_rule": "evenodd",
                        "shapes": [{"shape": "rect", "w": 2, "h": 2, "x": 8, "y": 8}]}],
            "svg": {"source": "<svg/>",
                    "classes": [{"selector": ".o", "class": "outliers"},
                                {"selector": "text", "class": "ignore"}],
                    "default_class": "ink", "auto_mark_items": true, "tolerance": 0.5}
          }
        }""", problem.toJson());
  }

  @Test
  void priorityTiersCoverageSolverAndOutput() {
    var problem = LabelProblem.builder()
        .item("a", 1, 2, Label.text("A"))
        .priority(Priority.attr("cbo").log1p().weight(0.5)
            .minus(Priority.labelSize().times(0.2))
            .plus(Priority.expr("attrs.loc * 2").normalize(Priority.Normalize.MINMAX))
            .plus(Priority.centrality().sqrt()))
        .tier("attrs.category == 'core'", 1)
        .tier("attrs.category == 'test'", -1)
        .omission(Omission.WEIGHTED)
        .coverage("attrs.region", 2)
        .ties(Ties.ANCHOR_X).band(0.05).maxLabels(10).maxInkFraction(0.4).focus(100, 50)
        .timeBudgetMs(200).seed(7).strategy(Strategy.GREEDY).maxIterations(1000).gridCell(2)
        .degrade(Degrade.ALTERNATIVES, Degrade.shrink(0.9), Degrade.OMIT)
        .minScale(0.8).wrapMaxLines(2).softOverlapWeight(5)
        .weights(Weights.defaults().position(1).leaderLength(0.5))
        .avoid(Avoid.buffer().weight("items", 2), Avoid.relaxable("points", "ink"),
            Avoid.label().ownMarkPartial(0.25).weight("*", 2))
        .debugSvg(true).costBreakdown(true).reportCandidates(false).itemShape(true)
        .option("placement.k_distant", 12)
        .build();
    assertSameJson("""
        {
          "items": [{"id": "a", "anchor": {"type": "point", "x": 1, "y": 2},
                     "label": {"type": "text", "text": "A"}}],
          "avoid": {"buffer": {"items": 2}, "relaxable": ["points", "ink"],
                    "label": {"own_mark": "partial:0.25", "*": 2}},
          "placement": {"k_distant": 12},
          "priority": {
            "terms": [{"attr": "cbo", "transform": "log1p", "weight": 0.5},
                      {"builtin": "label_size", "weight": -0.2},
                      {"expr": "attrs.loc * 2", "normalize": "minmax"},
                      {"builtin": "centrality", "transform": "sqrt"}],
            "tiers": [{"where": "attrs.category == 'core'", "tier": 1},
                      {"where": "attrs.category == 'test'", "tier": -1}],
            "omission": "weighted",
            "coverage": {"by": "attrs.region", "min_per_group": 2},
            "ties": "anchor_x", "band": 0.05,
            "budget": {"max_labels": 10, "max_ink_fraction": 0.4},
            "focus": [100, 50]
          },
          "solver": {"time_budget_ms": 200, "seed": 7, "strategy": "greedy",
                     "max_iterations": 1000, "grid_cell": 2},
          "degrade": ["alternatives", "shrink:0.9", "omit"],
          "degrade_options": {"min_scale": 0.8, "wrap_max_lines": 2, "soft_overlap_weight": 5},
          "weights": {"position": 1, "leader_length": 0.5},
          "output": {"debug_svg": true, "cost_breakdown": true, "candidates": false,
                     "item_shape": true}
        }""", problem.toJson());
  }

  @Test
  void priorityCallbackWritesExplicitPriorities() {
    var problem = LabelProblem.builder()
        .item("a", 1, 2, Label.text("A"), it -> it.attr("pop", 10))
        .item("b", 3, 4, Label.text("B"), it -> it.attr("pop", 30))
        .item("c", 5, 6, Label.text("C"), it -> it.attr("pop", 20).priority(99))
        .priority(Priority.callback(item -> item.attr("pop", 0) / 10)
            .plus(Priority.callback(item -> item.index())).times(2))
        .build();
    assertSameJson("""
        {"items": [
          {"id": "a", "anchor": {"type": "point", "x": 1, "y": 2},
           "label": {"type": "text", "text": "A"}, "attrs": {"pop": 10}, "priority": 2},
          {"id": "b", "anchor": {"type": "point", "x": 3, "y": 4},
           "label": {"type": "text", "text": "B"}, "attrs": {"pop": 30}, "priority": 8},
          {"id": "c", "anchor": {"type": "point", "x": 5, "y": 6},
           "label": {"type": "text", "text": "C"}, "attrs": {"pop": 20}, "priority": 99}
        ]}""", problem.toJson());
    assertEquals(List.of(0, 1, 2), problem.items().stream().map(Item::index).toList());
    assertThrows(IllegalArgumentException.class,
        () -> Priority.callback(i -> 1).plus(Priority.attr("x")));
    assertThrows(IllegalArgumentException.class, () -> LabelProblem.builder()
        .item("a", 1, 2, Label.text("A")).priority(Priority.callback(i -> Double.NaN)).build());
    assertThrows(IllegalStateException.class,
        () -> Priority.attr("a").plus(Priority.attr("b")).log1p());
  }

  @Test
  void pixelRasterTravelsByPointerAndEmbedsInPortableJson() {
    byte[] rgba = TestSupport.imageWithBlock(4, 2, 0, 0, 1, 1);
    ByteBuffer direct = ByteBuffer.allocateDirect(rgba.length).put(rgba).flip();
    var problem = LabelProblem.builder()
        .item("a", 1, 1, Label.text("A"))
        .background(Raster.pixels(4, 2, direct).mode(RasterMode.INK).scale(2).inkThreshold(0.2))
        .background(Raster.argb(1, 1, new int[] {0x80ff0000}).mode(RasterMode.ALPHA))
        .build();
    String data = Base64.getEncoder().encodeToString(rgba);
    String red = Base64.getEncoder().encodeToString(new byte[] {(byte) 255, 0, 0, (byte) 0x80});
    assertSameJson("""
        {"items": [{"id": "a", "anchor": {"type": "point", "x": 1, "y": 1},
                    "label": {"type": "text", "text": "A"}}],
         "obstacles": {"raster": [
           {"rgba": {"width": 4, "height": 2, "data": ""}, "mode": "ink", "scale": 2,
            "ink": {"threshold": 0.2}},
           {"rgba": {"width": 1, "height": 1, "data": "%s"}, "mode": "alpha"}]}}
        """.formatted(red), problem.toJson());
    assertSameJson("""
        {"items": [{"id": "a", "anchor": {"type": "point", "x": 1, "y": 1},
                    "label": {"type": "text", "text": "A"}}],
         "obstacles": {"raster": [
           {"rgba": {"width": 4, "height": 2, "data": "%s"}, "mode": "ink", "scale": 2,
            "ink": {"threshold": 0.2}},
           {"rgba": {"width": 1, "height": 1, "data": "%s"}, "mode": "alpha"}]}}
        """.formatted(data, red), problem.toPortableJson());
    assertTrue(problem.pointerPixels().direct != null, "direct buffer kept for the pointer");
    assertThrows(IllegalArgumentException.class, () -> Raster.pixels(4, 4, rgba));

    var encoded = LabelProblem.builder().item("a", 1, 1, Label.text("A"))
        .backgroundRaster(new byte[] {(byte) 0x89, 'P', 'N', 'G'}, RasterMode.COST).build();
    assertTrue(encoded.toJson().contains("\"source\":\"data:image/png;base64,iVBORw==\""),
        encoded.toJson());
  }

  @Test
  void optionObjectsAreImmutableValues() {
    Label.Text a = Label.text("A");
    Label.Text b = a.fontSize(14);
    assertNotEquals(a, b);
    assertEquals("{\"type\":\"text\",\"text\":\"A\"}", a.toJson());
    assertEquals(Label.text("A").fontSize(14), b);
    assertEquals("{\"label\":{\"x\":\"hard\"}}", Avoid.label().hard("x").toJson());
    assertNotEquals(Avoid.label().hard("x"), Avoid.leader().hard("x"));
    assertThrows(IllegalStateException.class, () -> Item.point("a", 1, 2).build());
    assertThrows(IllegalStateException.class, () -> Item.area("a", new double[][] {{0, 0},
        {1, 0}, {1, 1}}).mark(Mark.circle(1)));
    assertThrows(IllegalArgumentException.class, () -> Mark.polygon(new double[][] {{0, 0}}));
    assertEquals("shrink:0.85", Degrade.shrink(0.85).jsonName());
    assertEquals(8, Degrade.defaults().size());

    // warm start from a parsed result
    LabelResult prev = LabelResult.parse("""
        {"version": "1", "placements": [
          {"id": "a", "placed": true, "box": {"x": 1, "y": 2, "w": 3, "h": 4}},
          {"id": "b", "placed": false, "reason": "omitted_by_priority"}],
         "stats": {"placed": 1, "total": 2, "hard_violations": 0, "leader_crossings": 0,
                   "runtime_ms": 1, "seed": 0, "omission_order": ["b"],
                   "priority_inversions": 0}}""");
    var problem = LabelProblem.builder().item("a", 1, 2, Label.text("A"))
        .warmStart(prev).build();
    assertSameJson("""
        {"items": [{"id": "a", "anchor": {"type": "point", "x": 1, "y": 2},
                    "label": {"type": "text", "text": "A"}}],
         "warm_start": {"placements": [
           {"id": "a", "placed": true, "box": {"x": 1, "y": 2, "w": 3, "h": 4}},
           {"id": "b", "placed": false}]}}""", problem.toJson());
    assertEquals(Reason.OMITTED_BY_PRIORITY, prev.placement("b").orElseThrow().reason());
    assertEquals(List.of("b"), prev.omissionOrder());
    Map<String, Object> map = problem.toMap();
    assertThrows(UnsupportedOperationException.class, () -> map.put("x", 1));
  }
}
