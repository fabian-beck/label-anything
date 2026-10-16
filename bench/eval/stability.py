"""Frame-to-frame stability metrics for interactive sequences (scenario 11).

For consecutive frames t → t+1 (problems share item ids):

* **displacement**: for labels placed in both frames, the change of the label's
  offset from its anchor, |(c₁ − a₁) − (c₀ − a₀)| (box centers c, anchors a, in
  canvas px of each frame) — pan/zoom moves anchors, a stable label keeps its
  relative position; also in em of the label font,
* **flips**: fraction of those labels whose ``anchor_side`` changed,
* **added / removed**: labels that appear / disappear among items visible in both,
* **nesting** (zoom-in steps only): P_t ∩ V_{t+1} ⊆ P_{t+1}, where P are placed
  sets and V_{t+1} the items of the next frame; the step's nesting fraction is
  |P_t ∩ V_{t+1} ∩ P_{t+1}| / |P_t ∩ V_{t+1}|.
"""
from __future__ import annotations

import math
import statistics


def _frame_info(problem: dict, result: dict):
    from ..common.model import load_problem

    prob = load_problem(problem)
    refs = {it.id: (it.ref, it.label.em) for it in prob.items}
    placed = {}
    for p in result.get("placements", []):
        if p.get("placed") and "box" in p and p["id"] in refs:
            b = p["box"]
            placed[p["id"]] = ((b["x"] + b["w"] / 2, b["y"] + b["h"] / 2), p.get("anchor_side"))
    return refs, placed


def evaluate_sequence(frames: list[tuple[dict, dict]], steps: list[str]) -> dict:
    infos = [_frame_info(p, r) for p, r in frames]
    per_step = []
    all_disp, all_disp_em = [], []
    flips = common_total = 0
    zoom_steps = zoom_nested = 0
    nest_fracs = []
    for t in range(len(infos) - 1):
        (refs0, pl0), (refs1, pl1) = infos[t], infos[t + 1]
        step = steps[t + 1] if t + 1 < len(steps) else "unknown"
        visible = set(refs0) & set(refs1)
        common = sorted(set(pl0) & set(pl1))
        disp = []
        nflip = 0
        for i in common:
            (c0, s0), (c1, s1) = pl0[i], pl1[i]
            a0, a1 = refs0[i][0], refs1[i][0]
            d = math.hypot((c1[0] - a1[0]) - (c0[0] - a0[0]), (c1[1] - a1[1]) - (c0[1] - a0[1]))
            disp.append(d)
            all_disp.append(d)
            all_disp_em.append(d / refs1[i][1])
            if s0 != s1:
                nflip += 1
        flips += nflip
        common_total += len(common)
        p0v = set(pl0) & visible
        added = len((set(pl1) & visible) - set(pl0))
        removed = len(p0v - set(pl1))
        entry = {"step": step, "from": t, "to": t + 1, "common": len(common), "added": added, "removed": removed,
                 "displacement_mean_px": statistics.fmean(disp) if disp else None,
                 "flip_rate": nflip / len(common) if common else None}
        if step == "zoom_in":
            prev = set(pl0) & set(refs1)
            kept = prev & set(pl1)
            frac = len(kept) / len(prev) if prev else 1.0
            nest_fracs.append(frac)
            zoom_steps += 1
            zoom_nested += int(kept == prev)
            entry["nesting_fraction"] = frac
            entry["nested"] = kept == prev
        per_step.append(entry)
    return {
        "frames": len(frames),
        "displacement_mean_px": statistics.fmean(all_disp) if all_disp else None,
        "displacement_median_px": statistics.median(all_disp) if all_disp else None,
        "displacement_mean_em": statistics.fmean(all_disp_em) if all_disp_em else None,
        "flip_rate": flips / common_total if common_total else None,
        "zoom_in_steps": zoom_steps,
        "nesting_rate": zoom_nested / zoom_steps if zoom_steps else None,
        "nesting_fraction_mean": statistics.fmean(nest_fracs) if nest_fracs else None,
        "added_total": sum(s["added"] for s in per_step),
        "removed_total": sum(s["removed"] for s in per_step),
        "steps": per_step,
    }
