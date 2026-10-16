/*
 * Label Anything from Java: label a small "map" with a raster background passed by
 * pointer, leaders on fixed angles and priority-driven omission. See README.md here for
 * the build commands; run from the repository root:
 *
 *   java --enable-native-access=ALL-UNNAMED \
 *        -cp bindings/java/target/label-anything-0.1.0.jar examples/java/Main.java [overlay.svg]
 */
import io.github.fabianbeck.labelanything.Avoid;
import io.github.fabianbeck.labelanything.Item;
import io.github.fabianbeck.labelanything.Label;
import io.github.fabianbeck.labelanything.LabelAnything;
import io.github.fabianbeck.labelanything.LabelAnythingException;
import io.github.fabianbeck.labelanything.LabelPlacement;
import io.github.fabianbeck.labelanything.LabelProblem;
import io.github.fabianbeck.labelanything.LabelResult;
import io.github.fabianbeck.labelanything.Leaders;
import io.github.fabianbeck.labelanything.Mark;
import io.github.fabianbeck.labelanything.Omission;
import io.github.fabianbeck.labelanything.Priority;
import io.github.fabianbeck.labelanything.Raster;
import io.github.fabianbeck.labelanything.RasterMode;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;

public class Main {
  static final int W = 640;
  static final int H = 400;

  public static void main(String[] args) throws Exception {
    System.out.println("label-anything " + LabelAnything.version() + " via "
        + LabelAnything.backend());

    // A raster background: white with a dark diagonal "river". A direct buffer is handed
    // to the native library in place (no base64, no image decoding).
    ByteBuffer rgba = ByteBuffer.allocateDirect(W * H * 4);
    for (int y = 0; y < H; y++) {
      for (int x = 0; x < W; x++) {
        boolean river = Math.abs(y - (0.5 * x + 60)) < 9;
        byte v = (byte) (river ? 40 : 255);
        rgba.put(v).put(v).put(river ? (byte) 160 : v).put((byte) 255);
      }
    }
    rgba.flip();

    // 40 towns from a fixed pseudo-random sequence, 16 of them in a dense cluster;
    // traffic drives the priority.
    LabelProblem.Builder b = LabelProblem.builder()
        .canvas(W, H).fontSize(12)
        .background(Raster.pixels(W, H, rgba).mode(RasterMode.INK))
        .avoid(Avoid.label().hard("labels").weight("ink", 5))
        .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
        .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5).times(0.5)))
        .omission(Omission.STRICT);
    long seed = 42;
    for (int i = 0; i < 40; i++) {
      seed = seed * 6364136223846793005L + 1442695040888963407L;
      long r1 = seed >>> 33;
      seed = seed * 6364136223846793005L + 1442695040888963407L;
      long r2 = seed >>> 33;
      boolean cluster = i < 16;
      double x = cluster ? 430 + r1 % 60 : 40 + r1 % (W - 80);
      double y = cluster ? 110 + r2 % 50 : 30 + r2 % (H - 60);
      int traffic = 10 + (int) ((seed >>> 40) % 5000);
      b.item(Item.point("t" + i, x, y)
          .label(Label.text("Town " + i).alternatives("T" + i))
          .mark(Mark.circle(traffic > 4000 ? 5 : 3))
          .attr("traffic", traffic));
    }
    LabelProblem problem = b.build();

    LabelResult result = LabelAnything.place(problem);
    System.out.printf("placed %d of %d labels, hard violations %d, %s, %.1f ms%n",
        result.stats().placed(), result.stats().total(), result.stats().hardViolations(),
        result.stats().strategyUsed(), result.stats().runtimeMs());
    for (LabelPlacement p : result.placements().subList(0, 16)) { // the cluster
      if (p.placed()) {
        System.out.printf("  %-4s %-12s %-9s %-10s box=(%.1f, %.1f, %.1f x %.1f)%s%n",
            p.id(), p.text(), p.model(), p.anchorSide(), p.box().x(), p.box().y(),
            p.box().w(), p.box().h(),
            p.leader() == null ? "" : " leader " + p.leader().points().size() + " points");
      } else {
        System.out.printf("  %-4s omitted (%s)%n", p.id(), p.reason());
      }
    }
    System.out.println("omission order (lowest priority first): " + result.omissionOrder());

    Path svg = Path.of(args.length > 0 ? args[0] : "label-anything-java.svg");
    Files.writeString(svg, LabelAnything.renderSvg(problem, result));
    System.out.println("debug overlay: " + svg.toAbsolutePath());

    // Invalid problems throw with JSON pointers to the offending values.
    try {
      LabelAnything.place(LabelProblem.builder().canvas(-1, 100)
          .item("a", 1, 2, Label.text("A").padding("3qq")).build());
    } catch (LabelAnythingException e) {
      e.issues().forEach(issue -> System.out.println("invalid: " + issue));
    }
  }
}
