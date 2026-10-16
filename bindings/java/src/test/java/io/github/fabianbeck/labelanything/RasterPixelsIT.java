package io.github.fabianbeck.labelanything;

import static io.github.fabianbeck.labelanything.TestSupport.assertSameResult;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/** Raw RGBA pixels through the pointer entry point of {@code la_place_json}. */
class RasterPixelsIT {
  static final int W = 120;
  static final int H = 80;
  // ink block right above the anchor, where the label would go first (top)
  static final int BX = 30;
  static final int BY = 10;
  static final int BW = 60;
  static final int BH = 28;

  static final byte[] RGBA = TestSupport.imageWithBlock(W, H, BX, BY, BW, BH);

  private static LabelProblem problem(Raster raster) {
    var b = LabelProblem.builder()
        .canvas(W, H)
        .item(Item.point("p", 60, 40).mark(Mark.circle(2)).label(Label.text("Label")))
        .avoid(Avoid.label().hard("ink"), Avoid.relaxable()) // ink stays hard on every ladder step
        .strategy(Strategy.GREEDY);
    return (raster == null ? b : b.background(raster)).build();
  }

  private static Box box(LabelResult r) {
    return r.placement("p").orElseThrow().box();
  }

  private static int[] argb(byte[] rgba) {
    int[] out = new int[rgba.length / 4];
    for (int i = 0; i < out.length; i++) {
      out[i] = (rgba[4 * i + 3] & 0xff) << 24 | (rgba[4 * i] & 0xff) << 16
          | (rgba[4 * i + 1] & 0xff) << 8 | (rgba[4 * i + 2] & 0xff);
    }
    return out;
  }

  @Test
  void pixelsMoveTheLabelOffTheInk() {
    LabelResult plain = LabelAnything.place(problem(null));
    assertEquals(AnchorSide.TOP, plain.placement("p").orElseThrow().anchorSide(),
        "without background the label goes on top");
    ByteBuffer direct = ByteBuffer.allocateDirect(RGBA.length).put(RGBA).flip();
    LabelResult r = LabelAnything.place(problem(Raster.pixels(W, H, direct)));
    assertEquals(0, r.stats().hardViolations());
    LabelPlacement p = r.placement("p").orElseThrow();
    assertTrue(p.placed());
    assertNotEquals(AnchorSide.TOP, p.anchorSide());
    assertFalse(p.box().intersects(new Box(BX, BY, BW, BH)), "label avoids the ink: " + p.box());
    assertEquals(direct.capacity(), direct.limit(), "buffer untouched");
  }

  /** Every way to hand over the same pixels gives the same result as embedded base64. */
  @Test
  void allPixelSourcesAgree() {
    ByteBuffer direct = ByteBuffer.allocateDirect(RGBA.length).put(RGBA).flip();
    ByteBuffer offsetDirect = ByteBuffer.allocateDirect(RGBA.length + 7);
    offsetDirect.position(7);
    offsetDirect.put(RGBA).position(7);
    byte[] padded = new byte[RGBA.length + 5];
    System.arraycopy(RGBA, 0, padded, 5, RGBA.length);
    ByteBuffer heapSlice = ByteBuffer.wrap(padded, 5, RGBA.length);
    List<Raster> sources = List.of(
        Raster.pixels(W, H, direct),
        Raster.pixels(W, H, offsetDirect),
        Raster.pixels(W, H, direct.asReadOnlyBuffer()),
        Raster.pixels(W, H, RGBA),
        Raster.pixels(W, H, heapSlice),
        Raster.pixels(W, H, ByteBuffer.wrap(RGBA).asReadOnlyBuffer()),
        Raster.argb(W, H, argb(RGBA)));

    LabelProblem viaPointer = problem(sources.get(0));
    String reference = LabelAnything.placeJson(viaPointer.toPortableJson());
    assertFalse(viaPointer.toJson().equals(viaPointer.toPortableJson()));
    for (Raster raster : sources) {
      LabelProblem p = problem(raster);
      assertSameResult(reference, LabelAnything.place(p).json(), "pointer " + raster);
      for (NativeBackend b : TestSupport.allBackends()) {
        NativeBackend.Reply reply = b.place(p.toJson(), p.pointerPixels());
        assertEquals(NativeBackend.OK, reply.code(), reply.text());
        assertSameResult(reference, reply.text(), b.name() + " " + raster);
      }
    }
    // raw JSON without any raster object + pixels: default raster options, as in the C ABI
    String raw = problem(null).toJson();
    assertSameResult(reference, LabelAnything.place(raw, Raster.pixels(W, H, direct)).json(), "raw");
  }

  @Test
  void pixelRasterOptionsApply() {
    // the same image at half resolution with scale 0.5 covers the same canvas area
    int w = W / 2;
    int h = H / 2;
    byte[] small = TestSupport.imageWithBlock(w, h, BX / 2, BY / 2, BW / 2, BH / 2);
    LabelResult r = LabelAnything.place(problem(Raster.pixels(w, h, small).scale(0.5)));
    assertFalse(box(r).intersects(new Box(BX, BY, BW, BH)), box(r).toString());
    // alpha mode with an opaque white image: everything is an obstacle, so the label
    // (hard vs. ink) cannot be placed
    byte[] white = TestSupport.imageWithBlock(W, H, 0, 0, 0, 0);
    LabelResult blocked = LabelAnything.place(
        problem(Raster.pixels(W, H, white).mode(RasterMode.ALPHA)));
    assertFalse(blocked.placement("p").orElseThrow().placed(), blocked.json());
    assertEquals(Reason.NO_FEASIBLE_CANDIDATE, blocked.placement("p").orElseThrow().reason());
  }

  @Test
  void secondPixelRasterIsEmbedded() {
    Function<Raster, LabelProblem> withSecond = second -> LabelProblem.builder()
        .canvas(W, H)
        .item(Item.point("p", 60, 40).mark(Mark.circle(2)).label(Label.text("Label")))
        .avoid(Avoid.label().hard("ink"), Avoid.relaxable())
        .strategy(Strategy.GREEDY)
        .background(Raster.pixels(W, H, TestSupport.imageWithBlock(W, H, 0, 0, 0, 0)))
        .background(second)
        .build();
    LabelProblem p = withSecond.apply(Raster.pixels(W, H, RGBA));
    LabelResult r = LabelAnything.place(p);
    assertFalse(box(r).intersects(new Box(BX, BY, BW, BH)), box(r).toString());
    assertSameResult(LabelAnything.placeJson(p.toPortableJson()), r.json(), "two rasters");
  }
}
