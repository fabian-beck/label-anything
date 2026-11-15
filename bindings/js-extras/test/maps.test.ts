// @vitest-environment jsdom
import L from "leaflet";
import type { LabelResult } from "@label-anything/core";
import { describe, expect, it, vi } from "vitest";
import { labelLayer } from "../src/leaflet.js";
import { labelMapLibre, type MapLibreLike } from "../src/maplibre.js";
import { cliEngine, fakeEngine, overlaps } from "./engines.js";

const towns = [
  { id: "ba", name: "Bamberg", lat: 49.89, lng: 10.89, pop: 77 },
  { id: "n", name: "Nuremberg", lat: 49.45, lng: 11.08, pop: 518 },
  { id: "er", name: "Erlangen", lat: 49.6, lng: 11.0, pop: 117 },
  { id: "far", name: "Far away", lat: 10, lng: 10, pop: 1 },
];

function leafletMap() {
  document.body.innerHTML = '<div id="map"></div>';
  const map = L.map("map", { center: [49.6, 11.0], zoom: 8, zoomAnimation: false, fadeAnimation: false });
  // jsdom has no layout: give the map a size
  map.getSize = () => L.point(400, 300);
  map.setView([49.6, 11.0], 8, { animate: false });
  return map;
}

describe("Leaflet labelLayer", () => {
  it("labels the visible points in container pixels and re-solves warm after moves", () => {
    const map = leafletMap();
    const engine = fakeEngine();
    const layer = labelLayer(L, towns, {
      engine,
      latLng: (d) => [d.lat, d.lng],
      text: (d) => d.name,
      id: (d) => d.id,
      priority: (d) => d.pop,
      measure: false,
    }).addTo(map);
    const first = engine.last.problem;
    // the map is a window on a larger drawing: 8 times the font size (12 px) beyond its edges
    expect(first.canvas).toEqual({ width: 400, height: 300, overscan: 96 });
    expect(first.items.map((i) => i.id)).toEqual(["ba", "n", "er"]); // "far" is off-screen
    const n = map.latLngToContainerPoint([49.45, 11.08]);
    expect(first.items[1]!.anchor).toMatchObject({ x: n.x, y: n.y, mark: { shape: "circle", r: 4 } });
    expect(first.warm_start).toBeUndefined();
    const pane = map.getPane("labelAnything")!;
    expect(pane.querySelectorAll("svg text").length).toBe(3);
    expect(layer.result?.placements.length).toBe(3);

    map.panBy([30, 10], { animate: false });
    const second = engine.last.problem;
    expect(engine.calls.length).toBeGreaterThan(1);
    expect(second.warm_start?.placements.map((p) => p.id)).toEqual(["ba", "n", "er"]);
    // the map only moved: its labels are pinned, none may move
    expect(second.warm_start?.pin).toBe(true);
    // the warm boxes moved with the anchors
    const before = first.items[0]!.anchor as { x: number; y: number };
    const after = second.items[0]!.anchor as { x: number; y: number };
    expect(after.x - before.x).toBeCloseTo(-30, 6);
    const warm = second.warm_start!.placements[0]!.box!;
    const prev = layer.result!.placements[0]!.box!;
    expect(warm.x).toBeCloseTo(prev.x, 6);

    // after a zoom the labels beside their points stay there, giving way only to more
    // important ones (Leaflet may report the new view more than once: the first solve of
    // it counts)
    const solved = engine.calls.length;
    map.setView([49.6, 11.0], 9, { animate: false });
    const zoomed = engine.calls[solved]!.problem;
    expect(zoomed.warm_start?.placements.length).toBeGreaterThan(0);
    expect(zoomed.warm_start?.pin).toBe("yield");
    map.panBy([-20, 0], { animate: false });
    expect(engine.last.problem.warm_start?.pin).toBe(true);

    layer.setData(towns.slice(0, 2));
    expect(engine.last.problem.items.length).toBe(2);
    layer.remove();
    expect(pane.querySelector("svg")).toBeNull();
  });

  it("does not pin the labels of a map that keeps them inside, or with pin: false", () => {
    for (const off of [{ overscan: false as const }, { pin: false }]) {
      const map = leafletMap();
      const engine = fakeEngine();
      labelLayer(L, towns, { engine, latLng: (d) => [d.lat, d.lng], text: (d) => d.name, id: (d) => d.id, measure: false, ...off }).addTo(map);
      map.panBy([30, 10], { animate: false });
      expect(engine.last.problem.warm_start?.placements.length).toBe(3);
      expect(engine.last.problem.warm_start?.pin).toBeUndefined();
    }
  });

  it("passes the points near the map: labeled in the overscan, marks only beyond it", () => {
    const map = leafletMap();
    const at = (x: number, y: number) => map.containerPointToLatLng([x, y]);
    const [near, beyond, farther] = [at(460, 150), at(600, 150), at(720, 150)];
    const data = [
      ...towns,
      { id: "near", name: "Near", lat: near.lat, lng: near.lng, pop: 5 },
      { id: "beyond", name: "Beyond", lat: beyond.lat, lng: beyond.lng, pop: 5 },
      { id: "farther", name: "Farther", lat: farther.lat, lng: farther.lng, pop: 5 },
    ];
    const common = { latLng: (d: (typeof data)[number]) => [d.lat, d.lng] as [number, number], text: (d: (typeof data)[number]) => d.name, id: (d: (typeof data)[number]) => d.id, measure: false as const };
    const engine = fakeEngine();
    const layer = labelLayer(L, data, { engine, ...common }).addTo(map);
    // the overscan is 96 px: the engine labels "near" (60 px beyond the right edge); "beyond"
    // (200 px) is passed as a mark, up to three times the overscan; "farther" (320 px) is not
    expect(engine.last.problem.canvas).toEqual({ width: 400, height: 300, overscan: 96 });
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["ba", "n", "er", "near", "beyond"]);
    layer.remove();
    const wide = labelLayer(L, data, { engine, ...common, overscan: 150 }).addTo(map);
    expect(engine.last.problem.canvas).toEqual({ width: 400, height: 300, overscan: 150 });
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["ba", "n", "er", "near", "beyond", "farther"]);
    wide.remove();
    labelLayer(L, data, { engine, ...common, overscan: false }).addTo(map);
    expect(engine.last.problem.canvas).toEqual({ width: 400, height: 300 });
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["ba", "n", "er"]);
  });

  it.skipIf(!cliEngine)("moves no label while the map is panned, and labels what comes in", () => {
    const map = leafletMap();
    // towns all over the map and beyond it
    const data: { id: string; name: string; lat: number; lng: number; pop: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const ll = map.containerPointToLatLng([-300 + ((i * 97) % 1000), -200 + ((i * 53) % 700)]);
      data.push({ id: `t${i}`, name: `Town ${i}`, lat: ll.lat, lng: ll.lng, pop: (i * 31) % 17 });
    }
    const layer = labelLayer(L, data, { engine: cliEngine!, latLng: (d) => [d.lat, d.lng], text: (d) => d.name, id: (d) => d.id, priority: (d) => d.pop, measure: false }).addTo(map);
    const offsets = () =>
      new Map(layer.result!.placements.filter((p) => p.placed).map((p) => [p.id, [p.box!.x - p.anchor![0]!, p.box!.y - p.anchor![1]!] as const]));
    const outside = () => new Set(layer.result!.placements.filter((p) => p.reason === "outside").map((p) => p.id));
    let before = offsets();
    expect(before.size).toBeGreaterThan(20);
    expect(outside().size).toBeGreaterThan(5);
    let came = 0;
    for (let step = 0; step < 6; step++) {
      map.panBy([35, 12], { animate: false });
      const after = offsets();
      const marks = outside();
      for (const [id, a] of before) {
        const b = after.get(id);
        // a town that left the overscan is a mark only; every other label is where it was
        if (!b) expect(marks.has(id), `${id} lost its label at step ${step}`).toBe(true);
        else expect(Math.hypot(b[0] - a[0], b[1] - a[1]), `${id} moved at step ${step}`).toBeLessThan(1e-6);
      }
      for (const id of after.keys()) if (!before.has(id)) came++;
      expect(overlaps(layer.result!)).toEqual([]);
      before = after;
    }
    expect(came).toBeGreaterThan(3);
  });

  it.skipIf(!cliEngine)("lets a label at the map's edge cross it, where the map cuts it", () => {
    const map = leafletMap();
    const edge = map.containerPointToLatLng([392, 150]);
    const data = [...towns, { id: "edge", name: "Edgewater", lat: edge.lat, lng: edge.lng, pop: 5 }];
    const common = { engine: cliEngine!, latLng: (d: (typeof data)[number]) => [d.lat, d.lng] as [number, number], text: (d: (typeof data)[number]) => d.name, id: (d: (typeof data)[number]) => d.id, measure: false as const };
    const box = (r: LabelResult | undefined) => r!.placements.find((p) => p.id === "edge")!.box!;
    const cut = labelLayer(L, data, common).addTo(map);
    const b = box(cut.result);
    expect(b.x + b.w).toBeGreaterThan(400);
    expect(overlaps(cut.result!)).toEqual([]);
    cut.remove();
    const inside = labelLayer(L, data, { ...common, overscan: false }).addTo(map);
    const c = box(inside.result);
    expect(c.x + c.w).toBeLessThanOrEqual(400);
  });

  it("keeps labels on their anchors when they are drawn while the map is dragged", async () => {
    const map = leafletMap();
    const base = fakeEngine();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = {
      async place(problem: Parameters<typeof base.place>[0], options?: Parameters<typeof base.place>[1]) {
        await gate;
        return base.place(problem, options) as LabelResult;
      },
    };
    labelLayer(L, towns, { engine, latLng: (d) => [d.lat, d.lng], text: (d) => d.name, id: (d) => d.id, measure: false, transition: 0 }).addTo(map);
    const mapPane = map.getPane("mapPane")!;
    const svg = map.getPane("labelAnything")!.querySelector("svg")!;
    // where Bamberg's label is on the screen, relative to its anchor
    const offset = () => {
      const text = svg.querySelector('g[data-id="ba"] text')!;
      const x = L.DomUtil.getPosition(mapPane).x + L.DomUtil.getPosition(svg as never).x + Number(text.getAttribute("x"));
      return x - map.latLngToContainerPoint([49.89, 10.89]).x;
    };
    // a drag moves the map pane, and the overlay with it; the result arrives meanwhile
    L.DomUtil.setPosition(mapPane, L.DomUtil.getPosition(mapPane).add([-50, 20]));
    release();
    await new Promise((r) => setTimeout(r));
    const dragged = offset();
    expect(dragged).toBeGreaterThan(0); // right of the anchor, after the mark
    expect(dragged).toBeLessThan(20);
    map.fire("moveend");
    await new Promise((r) => setTimeout(r));
    expect(offset()).toBeCloseTo(dragged, 6);
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", () => {
    const map = leafletMap();
    const layer = labelLayer(L, towns, { engine: cliEngine!, latLng: (d) => [d.lat, d.lng], text: (d) => d.name, measure: false }).addTo(map);
    expect(layer.result!.placements.filter((p) => p.placed).length).toBe(3);
    expect(overlaps(layer.result!)).toEqual([]);
  });
});

describe("label transitions", () => {
  it("moves labels after the move delay and fades out omitted ones after the hold time", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    try {
      const map = fakeMap();
      const base = fakeEngine();
      // the second solve moves Bamberg's label 12 px down and omits Nuremberg's
      let second = false;
      const engine = {
        place(problem: Parameters<typeof base.place>[0], options?: Parameters<typeof base.place>[1]) {
          const r = base.place(problem, options) as LabelResult;
          if (!second) return r;
          const placements = r.placements.map((p) =>
            p.id === "n" ? { id: "n", placed: false } : p.id === "ba" ? { ...p, box: { ...p.box!, y: p.box!.y + 12 } } : p,
          );
          return { ...r, placements } as LabelResult;
        },
      };
      const labels = labelMapLibre(map, towns, { engine, lngLat: (d) => [d.lng, d.lat], text: "name", id: (d) => d.id, measure: false });
      const svg = map.getCanvasContainer().querySelector("svg")!;
      const y = () => Number(svg.querySelector('g[data-id="ba"] text')!.getAttribute("y"));
      const y0 = y(); // the first solve is drawn at once
      second = true;
      map.fire("moveend");
      expect(y()).toBeCloseTo(y0, 6);
      vi.advanceTimersByTime(150);
      // both wait (500 ms): the next solve may put them back
      expect(y()).toBeCloseTo(y0, 6);
      const opacity = () => svg.querySelector('g[data-id="n"]')!.getAttribute("opacity");
      expect(opacity()).toBeNull();
      vi.advanceTimersByTime(500);
      expect(y()).toBeGreaterThan(y0 + 1);
      expect(y()).toBeLessThan(y0 + 12);
      const fading = Number(opacity());
      expect(fading).toBeGreaterThan(0);
      expect(fading).toBeLessThan(1);
      vi.advanceTimersByTime(600);
      expect(y()).toBeCloseTo(y0 + 12, 6);
      expect(svg.querySelector('g[data-id="n"]')).toBeNull();
      labels.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws every solve as it is with transition 0", () => {
    const map = fakeMap();
    const labels = labelMapLibre(map, towns, { engine: fakeEngine(), lngLat: (d) => [d.lng, d.lat], text: "name", id: (d) => d.id, measure: false, transition: 0 });
    const svg = map.getCanvasContainer().querySelector("svg")!;
    map.state.dx = 30;
    map.fire("moveend");
    expect(svg.querySelectorAll("[opacity]").length).toBe(0);
    expect(labels.result!.placements.filter((p) => p.placed).length).toBe(svg.querySelectorAll("text").length);
    labels.remove();
  });
});

/** A fake map: Web Mercator-free linear projection with a movable offset. */
function fakeMap() {
  const listeners = new Map<string, Set<() => void>>();
  const container = document.createElement("div");
  const state = { dx: 0, dy: 0, scale: 100, zoom: 7 };
  const map: MapLibreLike & { fire(e: string): void; state: typeof state } = {
    state,
    project: (ll) => {
      const [lng, lat] = Array.isArray(ll) ? ll : [(ll as { lng: number }).lng, (ll as { lat: number }).lat];
      return { x: (lng - 10.5) * state.scale + 200 + state.dx, y: (50 - lat) * state.scale + state.dy };
    },
    getCanvasContainer: () => container,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }),
    getZoom: () => state.zoom,
    on: (e, f) => listeners.set(e, (listeners.get(e) ?? new Set()).add(f)),
    off: (e, f) => listeners.get(e)?.delete(f),
    fire: (e) => listeners.get(e)?.forEach((f) => f()),
    queryRenderedFeatures: (_g, o) =>
      o?.layers?.includes("roads")
        ? [{ layer: { id: "roads" }, geometry: { type: "LineString", coordinates: [[10, 49.7], [12, 49.7]] } }]
        : [],
  };
  return map;
}

describe("MapLibre labels", () => {
  it("follows anchors while moving and re-solves on moveend", () => {
    const map = fakeMap();
    const engine = fakeEngine();
    const labels = labelMapLibre(map, towns, {
      engine,
      lngLat: (d) => [d.lng, d.lat],
      text: "name",
      id: (d) => d.id,
      avoidLayers: ["roads"],
      avoid: { label: { roads: "hard" } },
      measure: false,
    });
    const p = engine.last.problem;
    expect(p.canvas).toEqual({ width: 400, height: 300, overscan: 96 });
    expect(p.items.map((i) => i.id)).toEqual(["ba", "n", "er"]);
    const roads = p.obstacles!.vector!;
    expect(roads.map((v) => [v.class, v.width])).toEqual([["roads", 2]]);
    expect(roads[0]!.polylines![0]!.flat().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([150, 30, 350, 30]);
    const svg = map.getCanvasContainer().querySelector("svg")!;
    const x0 = Number(svg.querySelector("text")!.getAttribute("x"));
    map.state.dx = 15;
    map.fire("move");
    expect(engine.calls.length).toBe(1); // following does not solve
    expect(Number(svg.querySelector("text")!.getAttribute("x"))).toBeCloseTo(x0 + 15, 6);
    // a label follows its anchor out of the view instead of going back to where it was solved
    map.state.dx = -400;
    map.fire("move");
    expect(Number(svg.querySelector("text")!.getAttribute("x"))).toBeCloseTo(x0 - 400, 6);
    map.state.dx = 15;
    map.fire("moveend");
    expect(engine.calls.length).toBe(2);
    expect(engine.last.problem.warm_start?.placements.length).toBe(3);
    // the map only moved: its labels are pinned; after a zoom they give way to more
    // important ones
    expect(engine.last.problem.warm_start?.pin).toBe(true);
    map.state.zoom = 8;
    map.fire("moveend");
    expect(engine.last.problem.warm_start?.pin).toBe("yield");
    map.fire("moveend");
    expect(engine.last.problem.warm_start?.pin).toBe(true);
    expect(engine.calls.length).toBe(4);
    labels.remove();
    expect(map.getCanvasContainer().querySelector("svg")).toBeNull();
    map.fire("moveend");
    expect(engine.calls.length).toBe(4);
  });

  it("passes the points near the map, unless the labels are to stay inside", () => {
    const map = fakeMap();
    const engine = fakeEngine();
    // x = 450 and 720 px in a map of 400 px: 50 and 320 px beyond its right edge
    const data = [...towns, { id: "near", name: "Near", lat: 49.5, lng: 13.0, pop: 5 }, { id: "farther", name: "Farther", lat: 49.5, lng: 15.7, pop: 5 }];
    const common = { engine, lngLat: (d: (typeof data)[number]) => [d.lng, d.lat] as [number, number], text: "name", id: (d: (typeof data)[number]) => d.id, measure: false as const };
    labelMapLibre(map, data, common).remove();
    // up to three times the overscan of 96 px
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["ba", "n", "er", "near"]);
    labelMapLibre(map, data, { ...common, overscan: false }).remove();
    expect(engine.last.problem.canvas).toEqual({ width: 400, height: 300 });
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["ba", "n", "er"]);
  });
});
