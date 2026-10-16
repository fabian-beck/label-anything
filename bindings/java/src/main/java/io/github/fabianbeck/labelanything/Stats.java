package io.github.fabianbeck.labelanything;

import java.util.List;
import java.util.Map;

/**
 * Solve statistics (result {@code stats}).
 *
 * @param placed number of placed labels
 * @param total number of items
 * @param placedWeighted placed fraction weighted by priority
 * @param requiredPlaced whether every required item is placed
 * @param hardViolations hard constraint violations found by the independent verification (0)
 * @param leaderCrossings leader crossings found by the verification
 * @param runtimeMs wall-clock time of the solve
 * @param strategyUsed the strategy that ran (greedy, local, exact)
 * @param seed the PCG32 seed
 * @param iterations local search iterations
 * @param timeGuardHit whether the wall-clock guard stopped a phase early
 * @param candidates number of candidates generated
 * @param omissionOrder omitted ids from the lowest priority upward
 * @param priorityInversions violations of the strict omission rule (0 for strict)
 * @param totalCost total cost of the placed labels
 * @param degraded placed labels per degradation kind (wrapped, shrunk, distant, ...)
 * @param implementation e.g. {@code rust/0.1.0}
 * @param raw the complete stats JSON object (phases, grid, flicker, ...)
 */
public record Stats(
    int placed,
    int total,
    double placedWeighted,
    boolean requiredPlaced,
    int hardViolations,
    int leaderCrossings,
    double runtimeMs,
    Strategy strategyUsed,
    long seed,
    long iterations,
    boolean timeGuardHit,
    int candidates,
    List<String> omissionOrder,
    int priorityInversions,
    double totalCost,
    Map<String, Integer> degraded,
    String implementation,
    Map<String, Object> raw) {
  public Stats {
    omissionOrder = List.copyOf(omissionOrder);
    degraded = Map.copyOf(degraded);
  }

  static Stats fromJson(Object o) {
    Map<String, Object> m = Parse.map(o);
    return new Stats(
        Parse.integer(m.get("placed"), 0),
        Parse.integer(m.get("total"), 0),
        Parse.dbl(m.get("placed_weighted"), Double.NaN),
        Parse.bool(m.get("required_placed"), true),
        Parse.integer(m.get("hard_violations"), 0),
        Parse.integer(m.get("leader_crossings"), 0),
        Parse.dbl(m.get("runtime_ms"), 0),
        Strategy.fromJson(Parse.str(m.get("strategy_used"))),
        Parse.lng(m.get("seed"), 0),
        Parse.lng(m.get("iterations"), 0),
        Parse.bool(m.get("time_guard_hit"), false),
        Parse.integer(m.get("candidates"), 0),
        Parse.strings(m.get("omission_order")),
        Parse.integer(m.get("priority_inversions"), 0),
        Parse.dbl(m.get("total_cost"), Double.NaN),
        Parse.intMap(m.get("degraded")),
        Parse.str(m.get("implementation")),
        m);
  }
}
