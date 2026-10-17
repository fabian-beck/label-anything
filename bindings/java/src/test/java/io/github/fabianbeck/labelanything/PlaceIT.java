package io.github.fabianbeck.labelanything;

import static io.github.fabianbeck.labelanything.TestSupport.assertSameResult;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.fabianbeck.labelanything.json.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The public API end to end through the native library. */
class PlaceIT {
  @TempDir Path tmp;

  /** The PNG of {@code conformance/problems/raster-ink.json}. */
  private static byte[] inkPng() {
    @SuppressWarnings("unchecked")
    Map<String, Object> raster = (Map<String, Object>) ((Map<String, Object>) Json
        .parseObject(TestSupport.problem("raster-ink.json")).get("obstacles")).get("raster");
    String url = (String) raster.get("source");
    return Base64.getDecoder().decode(url.substring(url.indexOf(',') + 1));
  }

  @Test
  void versionAndBackend() {
    assertTrue(LabelAnything.version().matches("\\d+\\.\\d+\\.\\d+.*"), LabelAnything.version());
    String requested = TestSupport.requestedBackend();
    assertEquals(requested == null ? (Backends.ffmSupported() ? "ffm" : "jni") : requested,
        LabelAnything.backend());
    for (NativeBackend b : TestSupport.allBackends()) {
      assertEquals(LabelAnything.version(), b.version(), b.name());
    }
  }

  @Test
  void briefExcerptWithARealRasterFile() throws Exception {
    Path png = Files.write(tmp.resolve("map.png"), inkPng());
    var b = LabelProblem.builder()
        .canvas(80, 60).fontSize(12)
        .item("A", 40, 30, Label.text("Alpha"), it -> it.attr("traffic", 120))
        .item("B", 20, 12, Label.text("B"), it -> it.attr("traffic", 3))
        .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
        .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
        .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
        .omission(Omission.STRICT);
    LabelResult fromFile = LabelAnything.place(
        b.backgroundRaster(png, RasterMode.INK).build());
    assertEquals(0, fromFile.stats().hardViolations());
    assertEquals(2, fromFile.placements().size());
    assertTrue(fromFile.placement("A").orElseThrow().placed());
    assertEquals(List.of(), fromFile.warnings());

    // the same image as encoded bytes (data URL) gives the same result
    var b2 = LabelProblem.builder()
        .canvas(80, 60).fontSize(12)
        .item("A", 40, 30, Label.text("Alpha"), it -> it.attr("traffic", 120))
        .item("B", 20, 12, Label.text("B"), it -> it.attr("traffic", 3))
        .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
        .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
        .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
        .omission(Omission.STRICT)
        .backgroundRaster(inkPng(), RasterMode.INK);
    assertSameResult(fromFile.json(), LabelAnything.place(b2.build()).json(), "file vs bytes");
  }

  @Test
  void typedResultFields() {
    var problem = LabelProblem.builder()
        .canvas(500, 400)
        .strategy(Strategy.GREEDY)
        .debugSvg(true)
        .item(Item.point("hub", 250, 200).mark(Mark.circle(30)).label(Label.text("Hub")))
        .item("long", 100, 300, Label.text("A rather long label for wrapping")
            .wrap(Wrap.width(70).maxLines(3)))
        .item("icon", 100, 100, Label.icon(16, 16).rounded(3))
        .item("combo", 400, 300, Label.composite(Label.icon(10, 10), Label.text("Combo")).gap(2))
        .build();
    LabelResult r = LabelAnything.place(problem);
    assertEquals(0, r.stats().hardViolations());
    assertEquals(Strategy.GREEDY, r.stats().strategyUsed());
    assertEquals(4, r.stats().total());
    assertEquals(4, r.stats().placed());
    assertEquals("rust/" + LabelAnything.version(), r.stats().implementation());
    assertNotNull(r.debugSvg());
    assertTrue(r.debugSvg().contains("<svg"), r.debugSvg().substring(0, 40));

    LabelPlacement hub = r.placement("hub").orElseThrow();
    assertEquals(List.of("Hub"), hub.lines());
    assertEquals("Hub", hub.text());
    assertNotNull(hub.priority());
    LabelPlacement longLabel = r.placement("long").orElseThrow();
    assertTrue(longLabel.lines().size() >= 2, longLabel.lines().toString());
    assertTrue(longLabel.box().w() <= 70 + 10, longLabel.box().toString());
    LabelPlacement icon = r.placement("icon").orElseThrow();
    assertEquals(List.of(), icon.lines());
    assertTrue(icon.box().w() >= 16 && icon.box().h() >= 16, icon.box().toString());
    assertEquals(Model.ADJACENT, icon.model());
    for (LabelPlacement a : r.placed()) {
      for (LabelPlacement c : r.placed()) {
        if (a != c) {
          assertFalse(a.box().intersects(c.box()), a.id() + " overlaps " + c.id());
        }
      }
    }

    String svg = LabelAnything.renderSvg(problem, r);
    assertTrue(svg.contains("<svg") && svg.contains("</svg>"), svg.substring(0, 40));
    assertTrue(LabelAnything.validate(problem).valid());
  }

  @Test
  void fanLabelsAreTyped() {
    LabelResult r = LabelAnything.place(Json.write(TestSupport.placeCaseProblem("fan-always.json")));
    assertEquals(2, r.stats().placed());
    for (LabelPlacement p : r.placements()) {
      assertEquals(Model.FAN, p.model());
      assertEquals(AnchorSide.FAN, p.anchorSide());
      assertTrue(p.hasLeader());
    }
  }

  @Test
  void leadersAndOmissionsAreTyped() {
    LabelResult r = LabelAnything.place(TestSupport.problem("leaders-angles.json"));
    assertEquals(0, r.stats().hardViolations());
    boolean someLeader = false;
    for (LabelPlacement p : r.placements()) {
      if (p.leader() != null) {
        someLeader = true;
        assertTrue(p.hasLeader());
        assertTrue(p.leader().points().size() >= 2);
        assertNotNull(p.leader().style());
        assertNotNull(p.leader().port());
        assertTrue(p.leader().length() > 0);
        assertTrue(p.model() == Model.DISTANT || p.model() == Model.BOUNDARY, p.model() + "");
      }
      if (!p.placed()) {
        assertNotNull(p.reason());
        assertNull(p.box());
        assertNull(p.anchorSide());
        assertTrue(r.omissionOrder().contains(p.id()), r.omissionOrder() + " " + p.id());
        assertFalse(p.degradeSteps().isEmpty());
      }
    }
    assertTrue(someLeader, "leaders-angles.json places some labels with leaders");
    assertEquals(r.stats().total() - r.stats().placed(), r.omissionOrder().size());
  }

  @Test
  void priorityCallbackDecidesWhoIsOmitted() {
    // three labels compete for the only allowed position; one fits
    var b = LabelProblem.builder()
        .canvas(300, 100)
        .placement(Placement.models(Model.ADJACENT).positions(Placement.Position.TOP))
        .degrade(Degrade.OMIT)
        .strategy(Strategy.GREEDY);
    for (String id : new String[] {"low", "high", "mid"}) {
      b.item(Item.point(id, 150, 50).mark(Mark.circle(1))
          .label(Label.text("Wide label")).attr("rank", switch (id) {
            case "high" -> 3;
            case "mid" -> 2;
            default -> 1;
          }));
    }
    LabelResult byCallback = LabelAnything.place(
        b.priority(Priority.callback(item -> item.attr("rank", 0))).build());
    LabelResult byTerm = LabelAnything.place(b.priority(Priority.attr("rank")).build());
    for (LabelResult r : List.of(byCallback, byTerm)) {
      assertEquals(0, r.stats().hardViolations());
      assertTrue(r.placement("high").orElseThrow().placed(), r.json());
      assertFalse(r.placement("low").orElseThrow().placed(), r.json());
      assertEquals(2, r.omissionOrder().size(), r.omissionOrder().toString());
      assertEquals(Reason.OMITTED_BY_PRIORITY, r.placement("low").orElseThrow().reason());
    }
    assertEquals(3.0, byCallback.placement("high").orElseThrow().priority().score());
  }

  @Test
  void warmStartKeepsLabelsInPlace() {
    var b = LabelProblem.builder().canvas(300, 200)
        .item("a", 100, 100, Label.text("Alpha"))
        .item("b", 108, 104, Label.text("Beta"));
    LabelResult first = LabelAnything.place(b.build());
    LabelResult second = LabelAnything.place(b.warmStart(first).build());
    assertEquals(first.placement("a").orElseThrow().box(), second.placement("a").orElseThrow().box());
    assertEquals(first.placement("b").orElseThrow().box(), second.placement("b").orElseThrow().box());
  }

  @Test
  void warmStartFollowsTheAnchors() {
    // a wall above the point keeps the label from its first position, top
    LabelResult first = LabelAnything.place(LabelProblem.builder().canvas(300, 200)
        .vector(VectorLayer.of("wall").rect(70, 50, 60, 36))
        .avoid(Avoid.label().hard("wall"))
        .item("a", 100, 100, Label.text("Alpha")).build());
    LabelPlacement a0 = first.placement("a").orElseThrow();
    assertEquals(new Point(100, 100), a0.anchor());
    assertNotEquals(AnchorSide.TOP, a0.anchorSide());
    // the wall is gone and the point moved by (40, 20): the previous result as warm start
    // moves the box along, and it is kept
    LabelResult moved = LabelAnything.place(LabelProblem.builder().canvas(300, 200)
        .item("a", 140, 120, Label.text("Alpha"))
        .warmStart(first).build());
    LabelPlacement a1 = moved.placement("a").orElseThrow();
    assertEquals(a0.anchorSide(), a1.anchorSide());
    assertEquals(a0.box().x() + 40, a1.box().x(), 1e-9);
    assertEquals(a0.box().y() + 20, a1.box().y(), 1e-9);
  }

  @Test
  void rawJsonEntryPoints() {
    String json = TestSupport.problem("minimal.json");
    String raw = LabelAnything.placeJson(json);
    LabelResult parsed = LabelAnything.place(json);
    assertSameResult(raw, parsed.json(), "placeJson vs place");
    assertEquals(LabelResult.parse(raw).placements(), LabelResult.parse(parsed.json()).placements());
    assertEquals("1", Json.parseObject(raw).get("version"));
  }

  @Test
  void svgBackgroundFromFile() throws Exception {
    String svg = "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'>"
        + "<rect x='0' y='0' width='200' height='45' class='block'/></svg>";
    Path file = Files.writeString(tmp.resolve("bg.svg"), svg);
    var b = LabelProblem.builder()
        .item("a", 100, 60, Label.text("Below"))
        .avoid(Avoid.label().hard("blocked"));
    LabelResult fromFile = LabelAnything.place(
        b.background(Svg.file(file).classify(".block", "blocked")).build());
    LabelProblem inline = LabelProblem.builder()
        .item("a", 100, 60, Label.text("Below"))
        .avoid(Avoid.label().hard("blocked"))
        .background(Svg.markup(svg).classify(".block", "blocked")).build();
    LabelResult fromMarkup = LabelAnything.place(inline);
    assertSameResult(fromFile.json(), fromMarkup.json(), "svg file vs markup");
    Box box = fromMarkup.placement("a").orElseThrow().box();
    assertTrue(box.y() >= 45, "label avoids the hard SVG block: " + box);
  }
}
