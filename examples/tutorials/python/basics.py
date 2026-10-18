"""Getting started with Python (docs/getting-started/python.md): one call, the builder,
raw JSON, results, errors and callbacks."""

# --8<-- [start:one-call]
import label_anything as la

res = la.place(
    anchors=[(120, 80), (130, 85), (400, 300)],   # canvas px, y down
    labels=["Alpha", "Beta", "Gamma"],
    canvas=(800, 600),
)
for p in res.placements:
    print(p.id, p.placed, p.box, p.anchor_side, p.leader)
# --8<-- [end:one-call]
assert res.stats["placed"] == 3 and res.stats["hard_violations"] == 0

# --8<-- [start:builder]
p = (la.Problem(canvas=(480, 320), font_size=12, seed=1)
       .item((120, 80), "Bamberg", id="bamberg", attrs={"pop": 77}, mark=la.Mark.circle(4))
       .item((128, 90), "Nuremberg", id="nuremberg", attrs={"pop": 518})
       .vector("rivers", polylines=[[(0, 120), (480, 60)]], width=3)
       .avoid(rivers="hard")
       .leaders("straight", max_length="6em")
       .priority(la.Priority.attr("pop")))
problem = p.build()          # a JSON-serializable dict (problem.v1)
res = p.solve()
# --8<-- [end:builder]
assert problem["avoid"]["label"]["rivers"] == "hard" and res.stats["placed"] == 2

# --8<-- [start:raw]
problem = {
    "canvas": {"width": 400, "height": 300},
    "items": [
        {"id": "a", "anchor": {"type": "point", "x": 100, "y": 100}, "label": {"type": "text", "text": "Alpha"}},
        {"id": "b", "anchor": {"type": "point", "x": 104, "y": 102}, "label": {"type": "text", "text": "Beta"}},
    ],
}
report = la.validate(problem)          # Report(valid, errors, warnings); never raises
res = la.place_problem(problem)        # also: JSON text, a path to a .json file, a Problem
svg = la.render_svg(problem, res)      # the debug overlay
# --8<-- [end:raw]
assert report.valid and svg.startswith("<svg") and res.stats["placed"] == 2

# --8<-- [start:result]
print(res)                             # <Result placed=2/2 hard_violations=0 omitted=0>
a = res["a"]                           # the placement of item "a"
print(a.box.x, a.box.y, a.box.w, a.box.h, a.lines, a.baselines, a.model, a.anchor_side)
print(res.stats["runtime_ms"], res.omission_order, [u.reason for u in res.unplaced])
text = res.to_json()                   # the result JSON (result.v1)
# --8<-- [end:result]
assert a.placed and a.lines == ("Alpha",) and '"version":"1"' in text.replace(" ", "")

# --8<-- [start:errors]
try:
    la.place(anchors=[(10, 20)], labels=["A"], canvas=(-1, 100), padding="3qq")
except la.ValidationError as e:        # a ValueError
    for issue in e.errors:
        print(issue["pointer"], issue["code"], issue["message"])
# --8<-- [end:errors]
    assert {i["code"] for i in e.errors} >= {"range", "unit"}, e.errors
else:
    raise AssertionError("expected a ValidationError")


# --8<-- [start:callbacks]
def measure(text: str, font: la.FontSpec) -> la.TextMetrics:
    """Host text measurement (here: a monospace approximation)."""
    return la.TextMetrics(width=0.6 * font.size * len(text), ascent=0.8 * font.size, descent=0.2 * font.size)


token = la.CancelToken()               # token.cancel(), from any thread, stops the solve early
res = la.place(
    anchors=[(120, 80), (130, 85), (400, 300)], labels=["Alpha", "Beta", "Gamma"], canvas=(800, 600),
    measure=measure,                                        # text widths from the host
    cost=lambda c: 0.0 if c.box.y > 40 else 5.0,            # extra cost per candidate
    progress=lambda phase, fraction: print(phase, round(fraction, 2)),
    cancelled=token,
)
# --8<-- [end:callbacks]
assert res.stats["placed"] == 3
assert abs(res.placements[0].box.w - (0.6 * 12 * 5 + 2 * 0.15 * 12)) < 1e-6, res.placements[0].box
print("ok")
