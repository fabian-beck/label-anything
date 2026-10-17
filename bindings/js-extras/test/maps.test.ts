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
    expect(first.canvas).toEqual({ width: 400, height: 300 });
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
    // the warm boxes moved with the anchors
    const before = first.items[0]!.anchor as { x: number; y: number };
    const after = second.items[0]!.anchor as { x: number; y: number };
    expect(after.x - before.x).toBeCloseTo(-30, 6);
    const warm = second.warm_start!.placements[0]!.box!;
    const prev = layer.result!.placements[0]!.box!;
    expect(warm.x).toBeCloseTo(prev.x, 6);

    layer.setData(towns.slice(0, 2));
    expect(engine.last.problem.items.length).toBe(2);
    layer.remove();
    expect(pane.querySelector("svg")).toBeNull();
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", () => {
    const map = leafletMap();
    const layer = labelLayer(L, towns, { engine: cliEngine!, latLng: (d) => [d.lat, d.lng], text: (d) => d.name, measure: false }).addTo(map);
    expect(layer.result!.placements.filter((p) => p.placed).length).toBe(3);
    expect(overlaps(layer.result!)).toEqual([]);
  });
});

describe("label transitions", () => {
  it("glides moved labels into place and fades out omitted ones", () => {
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
      expect(y()).toBeGreaterThan(y0 + 1);
      expect(y()).toBeLessThan(y0 + 12);
      const fading = Number(svg.querySelector('g[data-id="n"]')!.getAttribute("opacity"));
      expect(fading).toBeGreaterThan(0);
      expect(fading).toBeLessThan(1);
      vi.advanceTimersByTime(400);
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
  const state = { dx: 0, dy: 0, scale: 100 };
  const map: MapLibreLike & { fire(e: string): void; state: typeof state } = {
    state,
    project: (ll) => {
      const [lng, lat] = Array.isArray(ll) ? ll : [(ll as { lng: number }).lng, (ll as { lat: number }).lat];
      return { x: (lng - 10.5) * state.scale + 200 + state.dx, y: (50 - lat) * state.scale + state.dy };
    },
    getCanvasContainer: () => container,
    getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }),
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
    map.fire("moveend");
    expect(engine.calls.length).toBe(2);
    expect(engine.last.problem.warm_start?.placements.length).toBe(3);
    labels.remove();
    expect(map.getCanvasContainer().querySelector("svg")).toBeNull();
    map.fire("moveend");
    expect(engine.calls.length).toBe(2);
  });
});
