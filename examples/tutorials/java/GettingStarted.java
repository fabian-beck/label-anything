/*
 * Getting started with Java (docs/getting-started/java.md): the builder, results, errors,
 * raw JSON and raster pixels. Run in a copy of examples/tutorials/data:
 *
 *   java --enable-native-access=ALL-UNNAMED -cp label-anything-0.1.0.jar ../java/GettingStarted.java
 */
import io.github.fabianbeck.labelanything.*;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;

public class GettingStarted {
  public static void main(String[] args) throws Exception {
    // --8<-- [start:builder]
    LabelProblem problem = LabelProblem.builder()
        .canvas(480, 320).fontSize(12)
        .item("bamberg", 120, 80, Label.text("Bamberg"), it -> it.mark(Mark.circle(4)).attr("pop", 77_000))
        .item("nuremberg", 128, 90, Label.text("Nuremberg").alternatives("Nbg."), it -> it.attr("pop", 518_000))
        .item(Item.point("erlangen", 124, 70).label(Label.text("Erlangen")).attr("pop", 117_000))
        .vector(VectorLayer.of("rivers").polyline(0, 120, 480, 60).width(3))
        .avoid(Avoid.label().hard("rivers").weight("ink", 0.5))
        .leaders(Leaders.straight().maxLength("6em"))
        .priority(Priority.attr("pop"))
        .omission(Omission.STRICT)
        .build();
    LabelResult result = LabelAnything.place(problem);
    // --8<-- [end:builder]

    // --8<-- [start:results]
    for (LabelPlacement p : result.placements()) {
      if (p.placed()) {
        System.out.println(p.id() + " " + p.lines() + " " + p.box() + " " + p.model() + " " + p.anchorSide());
      } else {
        System.out.println(p.id() + " omitted: " + p.reason() + ", blocked by " + p.blockedBy());
      }
    }
    System.out.println(result.stats().placed() + "/" + result.stats().total() + ", omitted " + result.omissionOrder());
    Files.writeString(Path.of("debug.svg"), LabelAnything.renderSvg(problem, result));
    // --8<-- [end:results]
    check(result.stats().hardViolations() == 0 && result.stats().placed() == 3, result.toString());
    check(problem.toJson().contains("\"rivers\":\"hard\""), problem.toJson());

    // --8<-- [start:errors]
    try {
      LabelAnything.place(LabelProblem.builder().canvas(-1, 100)
          .item("a", 1, 2, Label.text("A").padding("3qq")).build());
    } catch (LabelAnythingException e) {
      e.issues().forEach(issue -> System.out.println(issue.pointer() + " [" + issue.code() + "] " + issue.message()));
    }
    // --8<-- [end:errors]

    // --8<-- [start:raw]
    String json = Files.readString(Path.of("outliers.json"));      // problem.v1 JSON text
    ValidationReport report = LabelAnything.validate(json);         // never throws for invalid problems
    LabelResult fromJson = LabelAnything.place(json);
    String resultJson = LabelAnything.placeJson(json);              // result.v1 JSON text
    // --8<-- [end:raw]
    check(report.valid() && fromJson.stats().placed() >= 18 && resultJson.startsWith("{"), report.toString());

    // --8<-- [start:pixels]
    int w = 400, h = 300;
    ByteBuffer rgba = ByteBuffer.allocateDirect(w * h * 4);         // row-major RGBA8, straight alpha
    for (int i = 0; i < w * h; i++) {
      boolean dark = (i % w) > 180 && (i % w) < 220;                // a dark vertical band
      byte v = (byte) (dark ? 30 : 250);
      rgba.put(v).put(v).put(v).put((byte) 255);
    }
    rgba.flip();
    LabelResult onPixels = LabelAnything.place(LabelProblem.builder()
        .backgroundPixels(w, h, rgba, RasterMode.INK)               // by address: no PNG, no base64
        .avoid(Avoid.label().hard("ink"))
        .item("p", 200, 150, Label.text("Over the band?"))
        .build());
    // --8<-- [end:pixels]
    LabelPlacement p = onPixels.placements().get(0);
    check(p.placed() && (p.box().maxX() <= 180 || p.box().x() >= 220 || p.hasLeader()), onPixels.json());
    System.out.println("ok via " + LabelAnything.backend());
  }

  static void check(boolean ok, String what) {
    if (!ok) {
      throw new AssertionError(what);
    }
  }
}
