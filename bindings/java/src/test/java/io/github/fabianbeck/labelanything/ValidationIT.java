package io.github.fabianbeck.labelanything;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** Invalid problems throw {@link LabelAnythingException} with JSON pointers. */
class ValidationIT {
  private static boolean has(List<Issue> issues, String pointer, String code) {
    return issues.stream().anyMatch(i -> i.pointer().equals(pointer) && i.code().equals(code));
  }

  @Test
  void invalidJsonProblemThrows() {
    String bad = "{\"items\":[{\"anchor\":{\"type\":\"point\",\"x\":1}}]}";
    LabelAnythingException e =
        assertThrows(LabelAnythingException.class, () -> LabelAnything.place(bad));
    assertEquals(LabelAnythingException.INVALID, e.code());
    assertTrue(e.isInvalidProblem());
    assertTrue(has(e.issues(), "/items/0/anchor/y", "required"), e.issues().toString());
    assertTrue(has(e.issues(), "/items/0/label", "required"), e.issues().toString());
    assertTrue(e.getMessage().contains("/items/0/anchor/y [required]"), e.getMessage());
    assertThrows(LabelAnythingException.class, () -> LabelAnything.placeJson(bad));
  }

  @Test
  void invalidBuilderProblemThrows() {
    var problem = LabelProblem.builder()
        .canvas(-1, 100)
        .item("a", 1, 2, Label.text("A").padding("3qq"))
        .item("a", 3, 4, Label.text("dup"))
        .item(Item.point("k", 5, 6).label(Label.text("K")).keepWithItems("nobody"))
        .placement(Placement.defaults().kDistant(-2))
        .build();
    LabelAnythingException e =
        assertThrows(LabelAnythingException.class, () -> LabelAnything.place(problem));
    List<Issue> issues = e.issues();
    assertTrue(has(issues, "/canvas/width", "range"), issues.toString());
    assertTrue(has(issues, "/items/0/label/padding", "unit"), issues.toString());
    assertTrue(has(issues, "/items/1/id", "duplicate_id"), issues.toString());
    assertTrue(has(issues, "/items/2/keep_with/0", "unknown_ref"), issues.toString());
    assertTrue(has(issues, "/placement/k_distant", "range"), issues.toString());

    ValidationReport report = LabelAnything.validate(problem);
    assertFalse(report.valid());
    assertEquals(issues, report.errors());
    assertThrows(LabelAnythingException.class, report::orThrow);
  }

  @Test
  void malformedJsonText() {
    LabelAnythingException e =
        assertThrows(LabelAnythingException.class, () -> LabelAnything.place("{\"items\": ["));
    assertEquals(LabelAnythingException.INVALID, e.code());
    assertEquals("parse", e.issues().get(0).code());
    ValidationReport report = LabelAnything.validate("not json");
    assertFalse(report.valid());
    assertEquals("parse", report.errors().get(0).code());
  }

  @Test
  void validateReportsWarningsWithoutThrowing() {
    var problem = LabelProblem.builder()
        .item("a", 1, 2, Label.text("A"))
        .avoid(Avoid.label().hard("outlierz"))
        .build();
    ValidationReport report = LabelAnything.validate(problem);
    assertTrue(report.valid(), report.toString());
    assertTrue(has(report.warnings(), "/avoid/label/outlierz", "unknown_class"),
        report.warnings().toString());
    assertTrue(report == report.orThrow());
    LabelResult r = LabelAnything.place(problem);
    assertTrue(has(r.warnings(), "/avoid/label/outlierz", "unknown_class"), r.warnings().toString());
  }

  @Test
  void renderSvgRejectsInvalidJson() {
    LabelAnythingException e = assertThrows(LabelAnythingException.class,
        () -> LabelAnything.renderSvg("{", "{}"));
    assertEquals("parse", e.issues().get(0).code());
  }

  @Test
  void rawPixelsMustBeAPixelRaster() {
    assertThrows(IllegalArgumentException.class,
        () -> LabelAnything.place("{\"items\":[]}", Raster.source("x.png")));
  }
}
