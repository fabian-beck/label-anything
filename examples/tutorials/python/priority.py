"""Priority and omission (docs/tutorials/priority.md): explicit priorities, terms, tiers,
coverage, keep_with, expressions, callables, the omission modes, and the explanations of
every omitted label. 40 cities in a small canvas: not every name fits."""

import json
from pathlib import Path

import label_anything as la

# --8<-- [start:data]
cities = json.loads(Path("../problems/priority-cities.json").read_text())["items"]
anchors = [(c["anchor"]["x"], c["anchor"]["y"]) for c in cities]
names = [c["label"]["text"] for c in cities]
attrs = [c["attrs"] for c in cities]                 # {"pop": 41000, "region": "North", "capital": true}
common = dict(ids=names, attrs=attrs, canvas=(480, 320), font_size=14,
              models=["adjacent", "slider"], degrade=["alternatives", "evict_lower", "omit"])
# --8<-- [end:data]

# --8<-- [start:explicit]
res = la.place(anchors, names, priority=[a["pop"] for a in attrs], **common)   # one number per item
print(res)                                 # <Result placed=28/40 hard_violations=0 omitted=12>
# --8<-- [end:explicit]
pop = {n: a["pop"] for n, a in zip(names, attrs)}
assert res.stats["placed"] < len(cities) and res.stats["priority_inversions"] == 0, res

# --8<-- [start:explain]
for p in res.unplaced:
    print(p.id, p.reason, p.blocking, p.blocked_by, p.priority)
# Berau omitted_by_priority ('items', 'labels') ('Kelsted',) {'tier': 0, 'score': 66376.0, 'rank': 13}
print(res.omission_order)                  # omitted ids, lowest priority first
print(res.stats["priority_inversions"])    # 0: no omitted label would fit next to the more important ones
# --8<-- [end:explain]
for p in res.unplaced:   # blocked by more important labels, or too close to other cities everywhere
    assert (p.reason == "omitted_by_priority" and p.blocked_by
            or p.reason == "no_feasible_candidate" and p.blocking == ("items",)), p
assert res["Berau"].blocked_by == ("Kelsted",), res["Berau"]
assert res.omission_order == sorted((p.id for p in res.unplaced), key=lambda i: pop[i])

# --8<-- [start:terms]
# min-max normalization keeps the log-scaled population's spread (rank keeps only its order)
priority = (la.Priority.attr("pop", "log1p", normalize="minmax") + 0.5 * la.Priority.outlierness()
            - 0.2 * la.Priority.label_size())
print(priority.to_terms())   # [{'attr': 'pop', 'transform': 'log1p', 'normalize': 'minmax'}, ...]
res = la.place(anchors, names, priority=priority, **common)
# --8<-- [end:terms]
assert res.stats["priority_inversions"] == 0 and res.placed[0].priority["terms"], res.placed[0].priority

# --8<-- [start:tiers]
res = la.place(anchors, names, priority=la.Priority.attr("pop"),
               tiers=[("attrs.capital == true", 1)], **common)          # tier 1 outranks tier 0
print([(p.id, p.placed, p.priority["tier"]) for p in res if p.priority["tier"] == 1])
# --8<-- [end:tiers]
assert all(p.placed for p in res if p.priority["tier"] == 1)

# --8<-- [start:coverage]
res = la.place(anchors, names, priority=la.Priority.attr("pop"),
               coverage=("attrs.region", 2), **common)   # >= 2 labels per region while space exists
by_region = {}
for p, a in zip(res.placements, attrs):
    by_region.setdefault(a["region"], []).append(p.id) if p.placed else None
print({r: len(ids) for r, ids in by_region.items()}, [p.id for p in res if p.priority.get("reserved")])
# --8<-- [end:coverage]
assert all(len(ids) >= 2 for ids in by_region.values()), by_region

# --8<-- [start:modes]
for omission in ["strict", "prefix", "weighted"]:
    res = la.place(anchors, names, priority=[a["pop"] for a in attrs], omission=omission, max_labels=25, **common)
    st = res.stats
    print(f"{omission:8} placed {st['placed']:2}  inversions {st['priority_inversions']}  "
          f"placed_weighted {st['placed_weighted']:.3f}")
# --8<-- [end:modes]
    assert st["placed"] <= 25
    ranks = sorted(p.priority["rank"] for p in res.placed)
    if omission == "prefix":
        assert ranks == list(range(len(ranks))), ranks            # the top of the priority order
    if omission != "weighted":
        assert st["priority_inversions"] == 0

# --8<-- [start:font-classes]
classes = [{"first": 4, "scale": 1.4, "weight": "bold"},   # the 4 most important cities
           {"first": "25%", "scale": 1.15},                 # then up to a quarter of all 40
           {"scale": 0.85}]                                 # and the rest
res = la.place(anchors, names, priority=[a["pop"] for a in attrs], font_classes=classes, **common)
for p in sorted(res.placed, key=lambda p: p.priority["rank"])[:6]:
    print(p.id, p.priority["font_class"], round(p.text["font_size"], 2), p.text["font_weight"])
# Rosbrück 0 19.6 700  ...  Kelsted 1 16.1 400
# --8<-- [end:font-classes]
assert [p.priority["font_class"] for p in res.placements] == [
    0 if p.priority["rank"] < 4 else 1 if p.priority["rank"] < 10 else 2 for p in res.placements]
assert all(p.text["font_size"] == 14 * classes[p.priority["font_class"]]["scale"] for p in res.placed
           if not p.degrade_steps)

# --8<-- [start:keep-with]
keep = [("twins" if n in ("Hofkel", "Roskel") else None) for n in names]   # all or none
res = la.place(anchors, names, priority=[a["pop"] for a in attrs], keep_with=keep, **common)
print(res["Hofkel"].placed, res["Roskel"].placed, res["Roskel"].reason)
# --8<-- [end:keep-with]
assert res["Hofkel"].placed == res["Roskel"].placed

# --8<-- [start:expr]
res = la.place(anchors, names, priority=la.Priority.expr("attrs.region == 'North'") + la.Priority.attr("pop"),
               tiers=[("attrs.pop > 100000 || attrs.capital == true", 1)], **common)
# --8<-- [end:expr]
assert res.stats["priority_inversions"] == 0

# --8<-- [start:callable]
def importance(item: dict) -> tuple[int, float]:
    """(tier, score) from the item dict, evaluated once per item before the solve."""
    a = item["attrs"]
    return (1 if a.get("capital") else 0, a["pop"] / (1 + len(item["label"]["text"])))


res = la.place(anchors, names, priority=importance, **common)
# --8<-- [end:callable]
assert all(p.placed for p, a in zip(res.placements, attrs) if a.get("capital"))

# --8<-- [start:full]
res = la.place(anchors, names, priority=la.Priority.attr("pop"),
               tiers=[("attrs.capital == true", 1)], coverage=("attrs.region", 2), omission="strict", **common)
# --8<-- [end:full]
same = la.place_problem(Path("../problems/priority-cities.json"))
assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements]
print("ok")
