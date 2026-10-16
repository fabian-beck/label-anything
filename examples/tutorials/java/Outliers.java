/*
 * Label your outliers in five lines (docs/tutorials/outliers.md), in Java. Run in a copy of
 * examples/tutorials/data:
 *
 *   java --enable-native-access=ALL-UNNAMED -cp label-anything-0.1.0.jar ../java/Outliers.java
 */
import io.github.fabianbeck.labelanything.*;
import java.nio.file.*;

public class Outliers {
  public static void main(String[] args) throws Exception {
    // --8<-- [start:five]
    var problem = LabelProblem.builder().preset(Preset.SCATTER).backgroundRaster(Path.of("scatter.png"), RasterMode.INK);
    Files.readAllLines(Path.of("outliers.csv")).stream().skip(1).map(line -> line.split(","))
        .forEach(f -> problem.item(f[0], Double.parseDouble(f[1]), Double.parseDouble(f[2]), Label.text(f[3])));
    LabelResult result = LabelAnything.place(problem.build());
    result.placements().forEach(p -> System.out.println(p.id() + " " + p.lines() + " " + p.box() + " " + p.leader()));
    // --8<-- [end:five]

    // --- checks (not shown in the docs) ---
    Stats s = result.stats();
    if (s.hardViolations() != 0 || s.leaderCrossings() != 0 || s.placed() < 18) {
      throw new AssertionError("unexpected result: " + result);
    }
    System.out.println("ok: " + result + " via " + LabelAnything.backend());
  }
}
