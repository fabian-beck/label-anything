package io.github.fabianbeck.labelanything;

import static io.github.fabianbeck.labelanything.TestSupport.assertSameResult;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** 8 threads × 50 solves through the active backend; every result equals the serial one. */
class ConcurrencyIT {
  static final int THREADS = 8;
  static final int SOLVES = 50;

  @Test
  void eightThreadsTimesFiftySolves() throws Exception {
    // a mix: conformance problems (greedy, deterministic) and a pixel raster by pointer
    List<LabelProblem> problems = new ArrayList<>();
    List<String> jsonProblems = new ArrayList<>();
    for (String name : List.of("scatter-basic.json", "leaders-angles.json", "bubbles.json",
        "svg-background.json", "raster-ink.json", "priority-attrs.json", "groups-keepwith.json")) {
      jsonProblems.add(TestSupport.greedy(TestSupport.problem(name)));
    }
    byte[] rgba = TestSupport.imageWithBlock(120, 80, 30, 10, 60, 28);
    ByteBuffer direct = ByteBuffer.allocateDirect(rgba.length).put(rgba).flip();
    problems.add(LabelProblem.builder()
        .canvas(120, 80)
        .item("p", 60, 40, Label.text("Label"))
        .item("q", 20, 60, Label.text("Other"))
        .backgroundPixels(120, 80, direct, RasterMode.INK)
        .avoid(Avoid.label().hard("ink"))
        .strategy(Strategy.GREEDY)
        .build());

    int kinds = jsonProblems.size() + problems.size();
    List<String> reference = new ArrayList<>();
    for (String json : jsonProblems) {
      reference.add(LabelAnything.placeJson(json));
    }
    for (LabelProblem p : problems) {
      reference.add(LabelAnything.place(p).json());
    }

    ExecutorService pool = Executors.newFixedThreadPool(THREADS);
    CountDownLatch start = new CountDownLatch(1);
    AtomicInteger solves = new AtomicInteger();
    List<Future<?>> futures = new ArrayList<>();
    try {
      for (int t = 0; t < THREADS; t++) {
        final int thread = t;
        futures.add(pool.submit(() -> {
          start.await();
          for (int i = 0; i < SOLVES; i++) {
            int k = (thread * 7 + i) % kinds;
            String json = k < jsonProblems.size()
                ? LabelAnything.placeJson(jsonProblems.get(k))
                : LabelAnything.place(problems.get(k - jsonProblems.size())).json();
            assertSameResult(reference.get(k), json, "thread " + thread + " solve " + i);
            assertEquals(0, LabelResult.parse(json).stats().hardViolations());
            solves.incrementAndGet();
          }
          return null;
        }));
      }
      start.countDown();
      for (Future<?> f : futures) {
        f.get(10, TimeUnit.MINUTES); // rethrows assertion failures of the workers
      }
    } finally {
      pool.shutdownNow();
    }
    assertEquals(THREADS * SOLVES, solves.get());
    assertTrue(direct.isDirect());
  }
}
