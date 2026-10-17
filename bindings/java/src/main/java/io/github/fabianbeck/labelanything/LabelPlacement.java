package io.github.fabianbeck.labelanything;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The outcome for one item (result {@code placements[i]}, in input order).
 *
 * @param id item id
 * @param placed whether the label is placed
 * @param box the label box (null when not placed)
 * @param anchor the item's anchor point (area items: the pole of the polygon; null when not
 *     placed); passed back as warm start, the box moves with it
 * @param anchorSide where the label sits relative to the anchor (null when not placed)
 * @param model the candidate model (null when not placed)
 * @param leader the leader, or null
 * @param fanLeaders fan leaders of a group label, one per member (else empty)
 * @param lines text lines as placed (wrapped, truncated or alternative text; empty for non-text labels)
 * @param reason why the item is not labeled (null when placed)
 * @param members group members sharing this label (else empty)
 * @param degradeSteps ladder steps used for this label
 * @param blocking for unplaced items: hard classes that rejected candidates, most frequent first
 * @param blockedBy for unplaced items: placed items occupying its space
 * @param priority the resolved priority key
 * @param raw the complete placement JSON object (text metrics, parts, cost, ...)
 */
public record LabelPlacement(
    String id,
    boolean placed,
    Box box,
    Point anchor,
    AnchorSide anchorSide,
    Model model,
    Leader leader,
    List<Leader> fanLeaders,
    List<String> lines,
    Reason reason,
    List<String> members,
    List<String> degradeSteps,
    List<String> blocking,
    List<String> blockedBy,
    PriorityInfo priority,
    Map<String, Object> raw) {
  public LabelPlacement {
    fanLeaders = List.copyOf(fanLeaders);
    lines = List.copyOf(lines);
    members = List.copyOf(members);
    degradeSteps = List.copyOf(degradeSteps);
    blocking = List.copyOf(blocking);
    blockedBy = List.copyOf(blockedBy);
  }

  /** Whether the label has a leader (or fan leaders). */
  public boolean hasLeader() {
    return leader != null || !fanLeaders.isEmpty();
  }

  /** The placed text, lines joined by {@code \n} (empty for non-text labels). */
  public String text() {
    return String.join("\n", lines);
  }

  static LabelPlacement fromJson(Object o) {
    Map<String, Object> m = Parse.map(o);
    List<Leader> fan = new ArrayList<>();
    for (Object l : Parse.list(m.get("leaders"))) {
      Leader leader = Leader.fromJson(l);
      if (leader != null) {
        fan.add(leader);
      }
    }
    return new LabelPlacement(
        Parse.str(m.get("id")),
        Parse.bool(m.get("placed"), false),
        Box.fromJson(m.get("box")),
        Parse.point(m.get("anchor")),
        AnchorSide.fromJson(Parse.str(m.get("anchor_side"))),
        Model.fromJson(Parse.str(m.get("model"))),
        Leader.fromJson(m.get("leader")),
        fan,
        Parse.strings(Parse.map(m.get("text")).get("lines")),
        Reason.fromJson(Parse.str(m.get("reason"))),
        Parse.strings(m.get("members")),
        Parse.strings(m.get("degrade_steps")),
        Parse.strings(m.get("blocking")),
        Parse.strings(m.get("blocked_by")),
        PriorityInfo.fromJson(m.get("priority")),
        m);
  }
}
