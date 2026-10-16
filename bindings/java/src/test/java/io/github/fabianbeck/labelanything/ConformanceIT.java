package io.github.fabianbeck.labelanything;

import static io.github.fabianbeck.labelanything.TestSupport.assertSameResult;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.github.fabianbeck.labelanything.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Every {@code conformance/problems/*.json} through the native library. Runs once per
 * backend (failsafe executions {@code it-ffm} and {@code it-jni}); the greedy results are
 * compared across FFM, JNI and the Rust CLI.
 */
class ConformanceIT {
  static Stream<String> problems() {
    return TestSupport.problemNames();
  }

  @BeforeAll
  static void backendAsRequested() {
    String requested = TestSupport.requestedBackend();
    if (requested != null) {
      assertEquals(requested, LabelAnything.backend(), "backend of this test run");
    }
  }

  @Test
  void suiteIsComplete() {
    assertTrue(problems().count() >= 20, "conformance problems found in " + TestSupport.problemsDir());
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("problems")
  void placesWithoutHardViolations(String name) {
    String json = TestSupport.problem(name);
    LabelResult r = LabelAnything.place(json);
    int items = Json.parseObject(json).get("items") instanceof List<?> l ? l.size() : -1;
    assertEquals(0, r.stats().hardViolations(), name + ": hard violations");
    assertEquals(items, r.placements().size(), name + ": one placement per item");
    assertEquals(items, r.stats().total(), name + ": stats.total");
    assertEquals(r.placed().size(), r.stats().placed(), name + ": stats.placed");
    for (LabelPlacement p : r.placements()) {
      assertNotNull(p.id());
      if (p.placed()) {
        assertNotNull(p.box(), name + "/" + p.id() + ": box");
        assertNotNull(p.anchorSide(), name + "/" + p.id() + ": anchor side");
        assertNotNull(p.model(), name + "/" + p.id() + ": model");
      } else {
        assertNotNull(p.reason(), name + "/" + p.id() + ": reason");
      }
    }
  }

  /** Greedy solves are identical through FFM, JNI and the CLI (wall-clock fields aside). */
  @ParameterizedTest(name = "{0}")
  @MethodSource("problems")
  void greedyMatchesAcrossBackendsAndCli(String name) throws Exception {
    String json = TestSupport.greedy(TestSupport.problem(name));
    String reference = LabelAnything.placeJson(json);
    assertEquals(0, LabelResult.parse(reference).stats().hardViolations(), name);
    for (NativeBackend b : TestSupport.allBackends()) {
      NativeBackend.Reply r = b.place(json, null);
      assertEquals(NativeBackend.OK, r.code(), name + " via " + b.name() + ": " + r.text());
      assertSameResult(reference, r.text(), name + ": " + LabelAnything.backend() + " vs " + b.name());
    }
    Path cli = TestSupport.cli();
    assumeTrue(cli != null, "CLI not built (cargo build --release -p label-anything-cli)");
    assertSameResult(reference, TestSupport.runCli(cli, json), name + ": " + LabelAnything.backend() + " vs CLI");
  }
}
