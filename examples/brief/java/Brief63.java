/*
 * The Java example of the design brief (§6.3), verbatim, after a prelude that creates the
 * map.png it assumes, followed by checks. It runs in the current directory:
 *
 *   examples/brief/java/run.sh [bindings/java/target/label-anything-0.1.0.jar]
 *
 * or, from a scratch directory,
 *
 *   java --enable-native-access=ALL-UNNAMED -cp label-anything-0.1.0.jar Brief63.java
 */
import io.github.fabianbeck.labelanything.Avoid;
import io.github.fabianbeck.labelanything.Box;
import io.github.fabianbeck.labelanything.Label;
import io.github.fabianbeck.labelanything.LabelAnything;
import io.github.fabianbeck.labelanything.LabelPlacement;
import io.github.fabianbeck.labelanything.LabelProblem;
import io.github.fabianbeck.labelanything.LabelResult;
import io.github.fabianbeck.labelanything.Leaders;
import io.github.fabianbeck.labelanything.Omission;
import io.github.fabianbeck.labelanything.Priority;
import io.github.fabianbeck.labelanything.RasterMode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.CRC32;
import java.util.zip.DeflaterOutputStream;

public class Brief63 {
  public static void main(String[] args) throws Exception {
    // --- prelude: map.png, 800 x 600, a light map with dark roads (no imaging library) ---
    Files.write(Path.of("map.png"), png(800, 600));

    // --- §6.3 verbatim ---
    var problem = LabelProblem.builder()
        .canvas(800, 600).fontSize(12)
        .item("A", 120, 80, Label.text("Alpha"))
        .backgroundRaster(Path.of("map.png"), RasterMode.INK)
        .avoid(Avoid.label().hard("labels").weight("ink", 0.5))
        .leaders(Leaders.angles(0, 45, 90, 135, 180, 225, 270, 315))
        .priority(Priority.attr("traffic").log1p().plus(Priority.outlierness(5)))
        .omission(Omission.STRICT)
        .build();
    LabelResult r = LabelAnything.place(problem);

    // --- checks ---
    check(problem.toJson().contains(quoted(Path.of("map.png").toAbsolutePath().toString())),
        "the raster is passed as an absolute path");
    check(r.stats().hardViolations() == 0, "no hard violations: " + r.stats());
    check(r.placements().size() == 1 && r.stats().total() == 1, "one placement");
    LabelPlacement a = r.placement("A").orElseThrow();
    check(a.placed(), "A is placed: " + r.json());
    check(a.lines().equals(java.util.List.of("Alpha")), "text Alpha: " + a.lines());
    Box b = a.box();
    check(b.x() >= 0 && b.y() >= 0 && b.maxX() <= 800 && b.maxY() <= 600, "inside the canvas: " + b);
    check(r.stats().raw().get("grid") != null, "stats as a raw map too");
    System.out.printf("ok (%s): A placed %s %s at (%.1f, %.1f) %.1f x %.1f, %d hard violations%n",
        LabelAnything.backend(), a.model(), a.anchorSide(), b.x(), b.y(), b.w(), b.h(),
        r.stats().hardViolations());
  }

  static String quoted(String s) {
    return io.github.fabianbeck.labelanything.json.Json.write(s);
  }

  static void check(boolean ok, String what) {
    if (!ok) {
      throw new AssertionError("check failed: " + what);
    }
  }

  /** An RGBA PNG: light background, dark horizontal and vertical roads every 60 px. */
  static byte[] png(int w, int h) throws IOException {
    ByteArrayOutputStream raw = new ByteArrayOutputStream();
    for (int y = 0; y < h; y++) {
      raw.write(0); // filter: none
      for (int x = 0; x < w; x++) {
        boolean road = x % 60 < 4 || y % 60 < 4;
        int v = road ? 60 : 235;
        raw.write(v);
        raw.write(v);
        raw.write(road ? 90 : v);
        raw.write(255);
      }
    }
    ByteArrayOutputStream z = new ByteArrayOutputStream();
    try (DeflaterOutputStream d = new DeflaterOutputStream(z)) {
      raw.writeTo(d);
    }
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
    chunk(out, "IHDR", ByteBuffer.allocate(13).putInt(w).putInt(h)
        .put((byte) 8).put((byte) 6).put((byte) 0).put((byte) 0).put((byte) 0).array());
    chunk(out, "IDAT", z.toByteArray());
    chunk(out, "IEND", new byte[0]);
    return out.toByteArray();
  }

  static void chunk(ByteArrayOutputStream out, String tag, byte[] data) {
    byte[] t = tag.getBytes(StandardCharsets.US_ASCII);
    CRC32 crc = new CRC32();
    crc.update(t);
    crc.update(data);
    out.writeBytes(ByteBuffer.allocate(4).putInt(data.length).array());
    out.writeBytes(t);
    out.writeBytes(data);
    out.writeBytes(ByteBuffer.allocate(4).putInt((int) crc.getValue()).array());
  }
}
