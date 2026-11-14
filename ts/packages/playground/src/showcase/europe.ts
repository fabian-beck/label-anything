/**
 * A map: the countries and capitals of Europe (examples/showcase/europe.py, live).
 *
 * The countries of Natural Earth in a Lambert azimuthal equal-area projection centred on
 * Europe. The map can be panned and zoomed; every view is labeled again, from the labels
 * shown, so they stay where they can. A country is an area: its name goes inside the part
 * of it that is in view, in full, wrapped or turned where that is narrow, out on a leader
 * where it is too small. Capitals are points; zoomed in, more cities, the smallest states
 * and more seas come. The seas' names are an SVG the engine reads: no label covers them.
 * At the first view the labels are those of the static figure.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import type { MotionFrame } from "@label-anything/extras";
import type { WorldCountry } from "./economies.js";
import type { Example, Info, Solve, Stage } from "./stage.js";
import { LABEL_FAMILY, button, clamp, clipRing, compact, easeInOut, esc, f2, html, inRing, ringArea, ringsPath, round, set, svg, type Pt, type Ring } from "./util.js";

const LON0 = 10.0;
const LAT0 = 52.0; // the projection's centre
const FRAME = [-1780.0, -2280.0, 2330.0, 1880.0] as const; // x0, y0, x1, y1 in km (y down)
const W = 880;
const SCALE = W / (FRAME[2] - FRAME[0]); // px per km
const H = Math.round((FRAME[3] - FRAME[1]) * SCALE);
const R_EARTH = 6371.0;
const PAD = 40; // the land is drawn this far beyond the map's edges
// names Natural Earth abbreviates, in full
const FULL: Record<string, string> = { BIH: "Bosnia and Herzegovina" };

const SEA = "#d3e3f1";
const LAND_OTHER = "#ebe7df";
const PALETTE = ["#f1dfba", "#d8e6c3", "#f0cfc2", "#ddd4ea", "#cfe3e5"];
const BORDER = "#8c8273";
const COUNTRY_TEXT = "#6e5f4f";
const CITY_TEXT = "#1f2328";
const SEA_TEXT = "#5a7fa8";

const MAX_ZOOM = 5;
/** From these zoom factors on: more cities and seas, the smallest states. */
const ZOOM_CITIES = 1.6; // one step of the zoom buttons
const ZOOM_SMALL = 3;

// the seas' names, drawn in the map: lines, lon, lat, and the zoom factor they come at
const SEAS: [string[], number, number, number][] = [
  [["Atlantic", "Ocean"], -11.8, 48.6, 1],
  [["Norwegian", "Sea"], 2.5, 67.0, 1],
  [["North", "Sea"], 3.2, 56.2, 1],
  [["Baltic", "Sea"], 19.6, 56.4, 1],
  [["Mediterranean Sea"], 4.6, 38.2, 1],
  [["Black Sea"], 34.2, 43.3, 1],
  [["Bay of", "Biscay"], -4.6, 45.4, ZOOM_CITIES],
  [["Celtic", "Sea"], -8.0, 50.2, ZOOM_CITIES],
  [["Tyrrhenian", "Sea"], 12.2, 39.9, ZOOM_CITIES],
  [["Ionian", "Sea"], 18.6, 37.6, ZOOM_CITIES],
  [["Aegean", "Sea"], 25.1, 38.9, ZOOM_SMALL],
  [["Gulf of", "Bothnia"], 20.0, 62.4, ZOOM_CITIES],
];
// capitals: name, lon, lat, country
const CAPITALS: [string, number, number, string][] = [
  ["Reykjavík", -21.94, 64.15, "ISL"], ["Dublin", -6.26, 53.35, "IRL"], ["London", -0.13, 51.51, "GBR"],
  ["Lisbon", -9.14, 38.72, "PRT"], ["Madrid", -3.70, 40.42, "ESP"], ["Paris", 2.35, 48.86, "FRA"],
  ["Brussels", 4.35, 50.85, "BEL"], ["Amsterdam", 4.90, 52.37, "NLD"], ["Luxembourg", 6.13, 49.61, "LUX"],
  ["Bern", 7.45, 46.95, "CHE"], ["Rome", 12.50, 41.90, "ITA"], ["Valletta", 14.51, 35.90, "MLT"],
  ["Berlin", 13.40, 52.52, "DEU"], ["Copenhagen", 12.57, 55.68, "DNK"], ["Oslo", 10.75, 59.91, "NOR"],
  ["Stockholm", 18.07, 59.33, "SWE"], ["Helsinki", 24.94, 60.17, "FIN"], ["Tallinn", 24.75, 59.44, "EST"],
  ["Riga", 24.11, 56.95, "LVA"], ["Vilnius", 25.28, 54.69, "LTU"], ["Warsaw", 21.01, 52.23, "POL"],
  ["Prague", 14.42, 50.08, "CZE"], ["Vienna", 16.37, 48.21, "AUT"], ["Bratislava", 17.11, 48.15, "SVK"],
  ["Budapest", 19.04, 47.50, "HUN"], ["Ljubljana", 14.51, 46.06, "SVN"], ["Zagreb", 15.98, 45.81, "HRV"],
  ["Sarajevo", 18.41, 43.86, "BIH"], ["Belgrade", 20.46, 44.79, "SRB"], ["Podgorica", 19.26, 42.43, "MNE"],
  ["Pristina", 21.17, 42.66, "KOS"], ["Skopje", 21.43, 42.00, "MKD"], ["Tirana", 19.82, 41.33, "ALB"],
  ["Athens", 23.73, 37.98, "GRC"], ["Sofia", 23.32, 42.70, "BGR"], ["Bucharest", 26.10, 44.43, "ROU"],
  ["Chișinău", 28.86, 47.01, "MDA"], ["Kyiv", 30.52, 50.45, "UKR"], ["Minsk", 27.56, 53.90, "BLR"],
  ["Moscow", 37.62, 55.76, "RUS"], ["Ankara", 32.85, 39.93, "TUR"], ["Nicosia", 33.38, 35.17, "CYP"],
  ["Rabat", -6.84, 34.02, "MAR"], ["Algiers", 3.06, 36.75, "DZA"], ["Tunis", 10.18, 36.81, "TUN"],
  ["Tbilisi", 44.79, 41.72, "GEO"],
];
// other cities, shown zoomed in: name, lon, lat, country, people (thousands, rounded)
const CITIES: [string, number, number, string, number][] = [
  ["Istanbul", 28.98, 41.01, "TUR", 15500], ["Saint Petersburg", 30.31, 59.94, "RUS", 5400], ["Barcelona", 2.17, 41.39, "ESP", 1620],
  ["Milan", 9.19, 45.46, "ITA", 1370], ["Munich", 11.58, 48.14, "DEU", 1490], ["Hamburg", 9.99, 53.55, "DEU", 1850],
  ["Cologne", 6.96, 50.94, "DEU", 1080], ["Frankfurt", 8.68, 50.11, "DEU", 760], ["Stuttgart", 9.18, 48.78, "DEU", 630],
  ["Dresden", 13.74, 51.05, "DEU", 560], ["Naples", 14.27, 40.85, "ITA", 910], ["Turin", 7.69, 45.07, "ITA", 850],
  ["Venice", 12.32, 45.44, "ITA", 250], ["Florence", 11.26, 43.77, "ITA", 360], ["Palermo", 13.36, 38.12, "ITA", 630],
  ["Marseille", 5.37, 43.30, "FRA", 870], ["Lyon", 4.84, 45.76, "FRA", 520], ["Toulouse", 1.44, 43.60, "FRA", 500],
  ["Bordeaux", -0.58, 44.84, "FRA", 260], ["Nice", 7.27, 43.70, "FRA", 340], ["Valencia", -0.38, 39.47, "ESP", 790],
  ["Seville", -5.98, 37.39, "ESP", 680], ["Bilbao", -2.93, 43.26, "ESP", 350], ["Málaga", -4.42, 36.72, "ESP", 580],
  ["Porto", -8.61, 41.15, "PRT", 230], ["Manchester", -2.24, 53.48, "GBR", 550], ["Birmingham", -1.90, 52.48, "GBR", 1140],
  ["Glasgow", -4.25, 55.86, "GBR", 630], ["Edinburgh", -3.19, 55.95, "GBR", 510], ["Belfast", -5.93, 54.60, "GBR", 340],
  ["Cork", -8.47, 51.90, "IRL", 220], ["Rotterdam", 4.48, 51.92, "NLD", 650], ["Antwerp", 4.40, 51.22, "BEL", 530],
  ["Zürich", 8.54, 47.37, "CHE", 430], ["Geneva", 6.14, 46.20, "CHE", 200], ["Salzburg", 13.05, 47.80, "AUT", 150],
  ["Gothenburg", 11.97, 57.71, "SWE", 580], ["Malmö", 13.00, 55.61, "SWE", 350], ["Bergen", 5.32, 60.39, "NOR", 280],
  ["Tromsø", 18.96, 69.65, "NOR", 77], ["Aarhus", 10.20, 56.16, "DNK", 280], ["Turku", 22.27, 60.45, "FIN", 190],
  ["Kraków", 19.94, 50.06, "POL", 780], ["Gdańsk", 18.65, 54.35, "POL", 470], ["Lviv", 24.03, 49.84, "UKR", 720],
  ["Odesa", 30.72, 46.48, "UKR", 1010], ["Kharkiv", 36.23, 49.99, "UKR", 1430], ["Cluj-Napoca", 23.59, 46.77, "ROU", 290],
  ["Varna", 27.91, 43.21, "BGR", 340], ["Split", 16.44, 43.51, "HRV", 160], ["Thessaloniki", 22.94, 40.64, "GRC", 320],
  ["İzmir", 27.14, 38.42, "TUR", 2950], ["Casablanca", -7.59, 33.57, "MAR", 3360], ["Oran", -0.63, 35.70, "DZA", 800],
  ["Rostov-on-Don", 39.72, 47.24, "RUS", 1140],
];
// not labeled: part of another's, or (unless zoomed in: SMALL) too small for a name
const SKIP = new Set(["AND", "MCO", "SMR", "LIE", "VAT", "ALD", "FRO", "GGY", "JEY", "IMN", "CYN", "-99"]);
const SMALL = new Set(["AND", "MCO", "SMR", "LIE"]);

interface Land {
  id: string;
  name: string;
  pop: number;
  gdp: number;
  /** Per part, its rings (outer first) in the map's px at zoom 1, uncut. */
  parts: Ring[][];
  /** The same, cut to the map (and a little beyond): what is drawn. */
  shapes: Ring[][];
  bounds: [number, number, number, number];
  colour: string;
  /** The rank among the countries labeled at zoom 1, by population (the type size follows it). */
  rank: number;
}

interface Place {
  id: string;
  name: string;
  at: Pt;
  land: string;
  capital: boolean;
  priority: number;
}

export interface View {
  k: number;
  x: number;
  y: number;
}

interface EuropeSolve extends Solve {
  view: View;
}

/** Lambert azimuthal equal-area (sphere), in px of the map at zoom 1. */
export function project(lon: number, lat: number): Pt {
  const rad = Math.PI / 180;
  const l = lon * rad;
  const p = lat * rad;
  const l0 = LON0 * rad;
  const p0 = LAT0 * rad;
  const k = Math.sqrt(2 / (1 + Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0)));
  const x = R_EARTH * k * Math.cos(p) * Math.sin(l - l0);
  const y = -R_EARTH * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0));
  return [(x - FRAME[0]) * SCALE, (y - FRAME[1]) * SCALE];
}

/** The countries on the map, in the data's order. */
function lands(world: WorldCountry[]): Land[] {
  const out: Land[] = [];
  const points = new Map<string, Set<string>>();
  for (const c of world) {
    let lon0 = Infinity, lon1 = -Infinity, lat0 = Infinity, lat1 = -Infinity;
    const pts = new Set<string>();
    for (const part of c.parts) {
      for (const [lon, lat] of part[0]!) {
        lon0 = Math.min(lon0, lon);
        lon1 = Math.max(lon1, lon);
        lat0 = Math.min(lat0, lat);
        lat1 = Math.max(lat1, lat);
        pts.add(`${lon.toFixed(2)},${lat.toFixed(2)}`);
      }
    }
    if (lon1 < -40 || lon0 > 65 || lat1 < 25 || lat0 > 80) continue;
    const parts = c.parts.map((part) => part.map((ring) => ring.map(([lon, lat]) => project(lon, lat))));
    const shapes = parts.map((rings) => rings.map((r) => clipRing(r, -PAD, -PAD, W + PAD, H + PAD))).filter((rings) => rings[0]!.length >= 3);
    if (!shapes.length) continue;
    const b: Land["bounds"] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const rings of shapes) {
      for (const [x, y] of rings[0]!) {
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
    }
    points.set(c.id, pts);
    out.push({ id: c.id, name: c.name, pop: c.pop ?? 0, gdp: c.gdp ?? 0, parts, shapes, bounds: b, colour: LAND_OTHER, rank: Infinity });
    (out.at(-1) as Land & { continent?: string }).continent = c.continent;
  }
  // neighbours in different colours (greedy, those with the longest outlines first)
  const shared = (a: string, b: string): boolean => {
    let n = 0;
    const pa = points.get(a)!;
    for (const p of points.get(b)!) if (pa.has(p) && ++n >= 2) return true;
    return false;
  };
  const order = out
    .filter((c) => (c as Land & { continent?: string }).continent === "Europe" || ["TUR", "CYP", "GEO"].includes(c.id))
    .sort((a, b) => points.get(b.id)!.size - points.get(a.id)!.size);
  const done: Land[] = [];
  for (const c of order) {
    const used = new Set(done.filter((d) => shared(c.id, d.id)).map((d) => d.colour));
    c.colour = PALETTE.find((p) => !used.has(p)) ?? PALETTE[0]!;
    done.push(c);
  }
  return out;
}

function graticule(): string {
  const lines: Pt[][] = [];
  for (let lon = -40; lon < 70; lon += 10) lines.push(Array.from({ length: 126 }, (_, i) => project(lon, (40 + i) / 2)));
  for (let lat = 30; lat < 90; lat += 10) lines.push(Array.from({ length: 231 }, (_, i) => project((i - 90) / 2, lat)));
  return lines.map((ln) => "M" + ln.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L")).join("");
}

export class Europe implements Example {
  readonly name = "europe";
  readonly width = W;
  readonly height = H;
  readonly title = "The countries and capitals of Europe, labeled live by Label Anything";
  readonly hint = "Drag to pan; zoom with the buttons, a double click, a pinch or Ctrl + scroll: more cities come as there is room. Hover or tap a country or a city.";
  readonly render = {
    font: { family: LABEL_FAMILY, size: 9.5, weight: 400, italic: false },
    fill: CITY_TEXT,
    halo: "rgba(255,255,255,0.75)",
    haloWidth: 2.4,
    leaderStroke: "#5f5a52",
    leaderWidth: 0.7,
    decorate: (text: SVGTextElement, p: { id: string }) => {
      if (!this.#places.has(p.id)) set(text, { fill: COUNTRY_TEXT, stroke: "none" });
    },
  };
  readonly motion = { duration: 260, appearDelay: 150, holdTime: 250, moveDelay: 200 };

  view: View = { k: 1, x: 0, y: 0 };
  #lands: Land[];
  #byId: Map<string, Land>;
  #places = new Map<string, Place>();
  #stage!: Stage;
  #map!: SVGGElement;
  #coast!: SVGGElement;
  #blur!: SVGElement;
  #seams!: SVGGElement;
  #seas!: SVGGElement;
  #dots!: SVGGElement;
  #dot = new Map<string, SVGCircleElement>();
  #buttons: { in?: HTMLButtonElement; out?: HTMLButtonElement; reset?: HTMLButtonElement } = {};
  #note!: HTMLDivElement;
  #noteTimer = 0;
  /** Where each item's anchor is on the map at zoom 1 (from the latest result). */
  #base = new Map<string, Pt>();
  #glide: { from: View; to: View; t0: number } | null = null;
  #pointers = new Map<number, Pt>();
  #moved = false;

  constructor(world: WorldCountry[]) {
    this.#lands = lands(world);
    this.#byId = new Map(this.#lands.map((c) => [c.id, c]));
    // the type size follows the rank among the countries labeled at zoom 1
    this.#countries(this.view)
      .sort((a, b) => b.land.pop - a.land.pop)
      .forEach((c, i) => (c.land.rank = i));
    for (const [name, lon, lat, iso] of CAPITALS) {
      this.#places.set(`capital-${iso}`, { id: `capital-${iso}`, name, at: project(lon, lat), land: iso, capital: true, priority: this.#byId.get(iso)?.pop ?? 0 });
    }
    for (const [name, lon, lat, iso, pop] of CITIES) {
      this.#places.set(`city-${name}`, { id: `city-${name}`, name, at: project(lon, lat), land: iso, capital: false, priority: pop * 1000 });
    }
  }

  #to(v: View, [x, y]: Pt): Pt {
    return [x * v.k + v.x, y * v.k + v.y];
  }

  /** The countries to label in a view, each with the part that carries the name: the largest in view. */
  #countries(v: View): { land: Land; main: Ring[] }[] {
    const out: { land: Land; main: Ring[] }[] = [];
    for (const land of this.#lands) {
      if (SKIP.has(land.id) && !(SMALL.has(land.id) && v.k >= ZOOM_SMALL)) continue;
      if (land.pop < 100_000 && !SMALL.has(land.id)) continue;
      const [x0, y0] = this.#to(v, [land.bounds[0], land.bounds[1]]);
      const [x1, y1] = this.#to(v, [land.bounds[2], land.bounds[3]]);
      if (x1 < 3 || y1 < 3 || x0 > W - 3 || y0 > H - 3) continue;
      let main: Ring[] | undefined;
      let best = 0;
      for (const part of land.parts) {
        const rings = part.map((ring) => clipRing(ring.map((p) => this.#to(v, p)), 3, 3, W - 3, H - 3));
        if (rings[0]!.length < 3) continue;
        const a = ringArea(rings[0]!);
        if (a > best) {
          best = a;
          main = rings.filter((r) => r.length >= 3);
        }
      }
      if (main) out.push({ land, main });
    }
    return out;
  }

  /** The seas' names in a view, as SVG markup: drawn, and read by the engine. */
  #seaMarkup(v: View): string {
    const o = [`<g class="seas" fill="${SEA_TEXT}" font-size="12.5" font-style="italic" text-anchor="middle">`];
    for (const [lines, lon, lat, zoom] of SEAS) {
      if (v.k < zoom) continue;
      const [x, y] = this.#to(v, project(lon, lat));
      if (x < -80 || x > W + 80 || y < -40 || y > H + 40) continue;
      lines.forEach((line, i) => o.push(`<text x="${f2(x)}" y="${f2(y + (i - (lines.length - 1) / 2) * 15 + 4)}">${esc(line)}</text>`));
    }
    o.push("</g>");
    return o.join("\n");
  }

  problem(v: View = this.view): LabelProblem {
    const countries = this.#countries(v).sort((a, b) => b.land.pop - a.land.pop);
    const size = (rank: number) => 9.5 * (rank < 9 ? 1.3 : rank < 24 ? 1.12 : 1);
    const items: unknown[] = countries.map(({ land, main }) => {
      const rings = main.map((r) => r.map(([x, y]) => [round(x, 1), round(y, 1)]));
      // every name in full: no abbreviations as alternatives, Natural Earth's spelled out
      const name = (FULL[land.id] ?? land.name).toUpperCase();
      return {
        id: land.id,
        anchor: { type: "area", polygon: rings[0], ...(rings.length > 1 ? { holes: rings.slice(1) } : {}), dot: { shape: "circle", r: 1 } },
        label: { type: "text", text: name, font: { size: round(size(land.rank), 3) }, ...(name.includes(" ") ? { wrap: { max_lines: 2 } } : {}) },
        // countries before cities
        priority: 1e9 + land.pop,
        // inside (wrapped or turned if need be), else out on a leader (the ladder's
        // `distant` step): a name beside a small country would read as its neighbour's
        placement: { models: ["internal"] },
      };
    });
    for (const p of this.#places.values()) {
      if (!p.capital && v.k < ZOOM_CITIES) continue;
      const [x, y] = this.#to(v, p.at);
      if (!(x > 4 && x < W - 4 && y > 4 && y < H - 4)) continue;
      items.push({
        id: p.id,
        anchor: { type: "point", x: round(x, 1), y: round(y, 1), mark: { shape: "circle", r: p.capital ? 2.6 : 2 } },
        label: { type: "text", text: p.name, font: { size: p.capital ? 10.5 : 9.5 } },
        priority: p.priority,
        placement: { position_order: "cartographic" },
      });
    }
    return {
      version: "1",
      canvas: { width: W, height: H, padding: 4 },
      defaults: { font: { size: 9.5 } },
      obstacles: {
        svg: {
          source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${this.#seaMarkup(v)}\n</svg>\n`,
          classes: [{ selector: ".seas text", class: "seas" }],
        },
      },
      items,
      // a country's leader may pass a city's dot (it starts at the country's centre, where
      // the capital often is); labels keep off the dots
      avoid: { label: { seas: "hard" }, leader: { seas: "hard", lower_items: 0.5 } },
      // names turn up to 60° along a country: Portugal's and Ireland's fit inside in full
      placement: { models: ["adjacent", "slider", "internal", "distant"], max_distance: "5em", inner_padding: 2, area_rotation: 60 },
      leaders: { style: "straight", max_length: "7em" },
      degrade: ["wrap", "distant", "omit"],
      solver: { seed: 4 },
    } as unknown as LabelProblem;
  }

  mount(stage: Stage): void {
    this.#stage = stage;
    this.#map = svg("g", { class: "la-ex-map" }, stage.picture);
    svg("rect", { x: -PAD, y: -PAD, width: W + 2 * PAD, height: H + 2 * PAD, fill: SEA }, this.#map);
    svg("path", { fill: "none", stroke: "#ffffff", "stroke-opacity": 0.6, "stroke-width": 0.6, "vector-effect": "non-scaling-stroke", d: graticule() }, this.#map);
    // water lining: a soft darker band along the coasts, under the land
    const filter = svg("filter", { id: "la-ex-soft", x: "-5%", y: "-5%", width: "110%", height: "110%" }, this.#map);
    this.#blur = svg("feGaussianBlur", { stdDeviation: 2.2 }, filter);
    this.#coast = svg("g", { fill: "none", stroke: "#a7c4de", "stroke-width": 6, "stroke-linejoin": "round", filter: "url(#la-ex-soft)" }, this.#map);
    // zoomed in, the simplified outlines of neighbours no longer meet: each country's colour closes the gaps
    this.#seams = svg("g", { fill: "none", "stroke-width": 2, "stroke-linejoin": "round", display: "none" }, this.#map);
    const land = svg("g", { stroke: BORDER, "stroke-width": 0.45, "stroke-linejoin": "round" }, this.#map);
    for (const c of this.#lands) {
      const d = c.shapes.map(ringsPath).join("");
      svg("path", { d }, this.#coast);
      svg("path", { d, stroke: c.colour, "vector-effect": "non-scaling-stroke" }, this.#seams);
      svg("path", { d, fill: c.colour, "fill-rule": "evenodd", "vector-effect": "non-scaling-stroke" }, land);
    }
    this.#seas = svg("g", {}, stage.picture);
    this.#dots = svg("g", { fill: "#ffffff", stroke: CITY_TEXT }, stage.top);

    const zoom = html("div", "la-example__zoom", undefined, stage.frameEl);
    this.#buttons.in = button(zoom, "+", () => this.zoomBy(1.7));
    this.#buttons.in.setAttribute("aria-label", "Zoom in");
    this.#buttons.out = button(zoom, "−", () => this.zoomBy(1 / 1.7));
    this.#buttons.out.setAttribute("aria-label", "Zoom out");
    this.#buttons.reset = button(stage.controls, "Whole map", () => this.go({ k: 1, x: 0, y: 0 }));
    this.#note = html("div", "la-example__note", "Hold Ctrl (⌘ on a Mac) and scroll to zoom the map", stage.frameEl);
    this.#note.hidden = true;

    const el = stage.svg;
    el.addEventListener("pointerdown", (ev) => this.#down(ev));
    el.addEventListener("pointermove", (ev) => this.#move(ev));
    for (const type of ["pointerup", "pointercancel"] as const) el.addEventListener(type, (ev) => this.#up(ev));
    el.addEventListener("wheel", (ev) => this.#wheel(ev), { passive: false });
    el.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      this.zoomBy(ev.shiftKey ? 0.5 : 2, stage.toCanvas(ev));
    });
    this.#show();
  }

  /** A view within bounds: at least the whole map, and never beyond its edges. */
  #fit(v: View): View {
    const k = clamp(v.k, 1, MAX_ZOOM);
    return { k, x: clamp(v.x, W - W * k, 0), y: clamp(v.y, H - H * k, 0) };
  }

  /** Zooms by a factor about a point of the drawing (default: its middle), gliding. */
  zoomBy(factor: number, about: Pt = [W / 2, H / 2]): void {
    const from = this.#glide?.to ?? this.view;
    const k = clamp(from.k * factor, 1, MAX_ZOOM);
    this.go({ k, x: about[0] - ((about[0] - from.x) * k) / from.k, y: about[1] - ((about[1] - from.y) * k) / from.k });
  }

  /** Glides to a view. */
  go(to: View): void {
    to = this.#fit(to);
    this.#stage.setHover(null);
    if (this.#stage.reduced) {
      this.#set(to, true);
      return;
    }
    this.#glide = { from: this.view, to, t0: performance.now() };
    this.#stage.kick();
  }

  #set(v: View, rest: boolean): void {
    this.view = this.#fit(v);
    this.#soft(rest);
    this.#show();
    // back at the whole map, the labels are those of the first view: solved afresh
    this.#stage.request(rest, rest && this.view.k === 1);
    this.#stage.kick();
  }

  /**
   * The band along the coasts is blurred while the map is still: blurring it anew for
   * every frame of a pan would halve the frame rate, so a moving map has it plain and lighter.
   */
  #soft(still: boolean): void {
    set(this.#coast, { filter: still ? "url(#la-ex-soft)" : undefined, "stroke-opacity": still ? undefined : 0.45 });
  }

  /** Draws the map and the seas' names at the view. */
  #show(): void {
    const { k, x, y } = this.view;
    set(this.#map, { transform: `translate(${f2(x)} ${f2(y)}) scale(${round(k, 4)})` });
    set(this.#coast, { "stroke-width": round(6 / k, 3) });
    set(this.#blur, { stdDeviation: round(2.2 / k, 3) });
    set(this.#seams, { display: k > 1 ? undefined : "none" });
    this.#seas.innerHTML = this.#seaMarkup(this.view);
    const whole = k === 1 && x === 0 && y === 0;
    if (this.#buttons.reset) this.#buttons.reset.disabled = whole;
    if (this.#buttons.out) this.#buttons.out.disabled = k <= 1;
    if (this.#buttons.in) this.#buttons.in.disabled = k >= MAX_ZOOM;
    this.#stage.svg.classList.toggle("is-zoomed", k > 1);
  }

  #down(ev: PointerEvent): void {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    this.#pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    this.#moved = false;
    this.#glide = null;
    // a touch pans a zoomed map; the whole map lets the page scroll
    if (ev.pointerType !== "touch" || this.view.k > 1 || this.#pointers.size > 1) this.#stage.svg.setPointerCapture(ev.pointerId);
  }

  #move(ev: PointerEvent): void {
    const last = this.#pointers.get(ev.pointerId);
    if (!last) return;
    const stage = this.#stage;
    const now: Pt = [ev.clientX, ev.clientY];
    const scale = W / stage.svg.getBoundingClientRect().width; // drawing px per screen px
    if (this.#pointers.size === 1) {
      const dx = (now[0] - last[0]) * scale;
      const dy = (now[1] - last[1]) * scale;
      if (!this.#moved && Math.hypot(now[0] - last[0], now[1] - last[1]) < 3) return;
      if (this.view.k > 1) {
        this.#begin();
        this.#set({ k: this.view.k, x: this.view.x + dx, y: this.view.y + dy }, false);
      }
    } else if (this.#pointers.size === 2) {
      // a pinch: the two fingers stay on the same places of the map
      const other = [...this.#pointers].find(([id]) => id !== ev.pointerId)![1];
      const d0 = Math.hypot(last[0] - other[0], last[1] - other[1]);
      const d1 = Math.hypot(now[0] - other[0], now[1] - other[1]);
      if (d0 > 0 && d1 > 0) {
        this.#begin();
        const mid0 = stage.toCanvas({ clientX: (last[0] + other[0]) / 2, clientY: (last[1] + other[1]) / 2 });
        const mid1 = stage.toCanvas({ clientX: (now[0] + other[0]) / 2, clientY: (now[1] + other[1]) / 2 });
        const k = clamp((this.view.k * d1) / d0, 1, MAX_ZOOM);
        this.#set({ k, x: mid1[0] - ((mid0[0] - this.view.x) * k) / this.view.k, y: mid1[1] - ((mid0[1] - this.view.y) * k) / this.view.k }, false);
      }
    }
    this.#pointers.set(ev.pointerId, now);
  }

  #begin(): void {
    if (this.#moved) return;
    this.#moved = true;
    this.#stage.gesture = true;
    this.#stage.setHover(null);
    this.#stage.svg.classList.add("is-panning");
  }

  #up(ev: PointerEvent): void {
    if (!this.#pointers.delete(ev.pointerId)) return;
    if (this.#pointers.size || !this.#moved) return;
    this.#moved = false;
    this.#stage.gesture = false;
    this.#stage.svg.classList.remove("is-panning");
    this.#soft(true);
    this.#stage.request(true);
  }

  #wheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) {
      // the page scrolls; say how to zoom instead
      this.#note.hidden = false;
      clearTimeout(this.#noteTimer);
      this.#noteTimer = window.setTimeout(() => (this.#note.hidden = true), 1600);
      return;
    }
    ev.preventDefault();
    this.#note.hidden = true;
    this.#glide = null;
    const about = this.#stage.toCanvas(ev);
    // a pinch on a trackpad comes as small steps, a wheel's notch as a large one: at most √2 each
    const factor = 2 ** clamp(-ev.deltaY * (ev.deltaMode === 1 ? 0.3 : ev.deltaMode ? 1 : 0.01), -0.5, 0.5);
    const k = clamp(this.view.k * factor, 1, MAX_ZOOM);
    this.#stage.setHover(null);
    this.#set({ k, x: about[0] - ((about[0] - this.view.x) * k) / this.view.k, y: about[1] - ((about[1] - this.view.y) * k) / this.view.k }, false);
    // the last notch of the wheel: solve at rest
    clearTimeout(this.#wheelTimer);
    this.#wheelTimer = window.setTimeout(() => {
      this.#soft(true);
      this.#stage.request(true);
    }, 250);
  }
  #wheelTimer = 0;

  frame(now: number): boolean {
    if (!this.#glide) return false;
    const { from, to, t0 } = this.#glide;
    const t = Math.min(1, (now - t0) / 350);
    const e = easeInOut(t);
    // the zoom factor grows evenly on a log scale; the map's point at the middle moves evenly
    const k = from.k * (to.k / from.k) ** e;
    const mid = (v: View): Pt => [(W / 2 - v.x) / v.k, (H / 2 - v.y) / v.k];
    const [a, b] = [mid(from), mid(to)];
    const m: Pt = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
    if (t >= 1) this.#glide = null;
    this.#set(t >= 1 ? to : { k, x: W / 2 - m[0] * k, y: H / 2 - m[1] * k }, t >= 1);
    return t < 1;
  }

  /** Where an item's anchor is on the map at zoom 1 when no result has said: its dot, its country's middle. */
  #home(id: string): Pt {
    const p = this.#places.get(id);
    if (p) return p.at;
    const b = this.#byId.get(id)?.bounds;
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
  }

  solve(): EuropeSolve {
    const view = this.view;
    const problem = this.problem(view);
    const anchors = new Map<string, Pt>();
    for (const it of problem.items) {
      const id = it.id as string;
      anchors.set(id, this.#to(view, this.#base.get(id) ?? this.#home(id)));
    }
    return { problem, anchors, view };
  }

  solved(result: LabelResult, solve: Solve): void {
    const v = (solve as EuropeSolve).view;
    for (const p of result.placements) {
      if (p.anchor) this.#base.set(p.id, [(p.anchor[0]! - v.x) / v.k, (p.anchor[1]! - v.y) / v.k]);
    }
  }

  anchors(): Map<string, Pt> {
    const out = new Map<string, Pt>();
    for (const [id, p] of this.#base) out.set(id, this.#to(this.view, p));
    return out;
  }

  /** A city's dot shows while its name does. */
  drawn(frame: MotionFrame): void {
    const seen = new Set<string>();
    for (const p of frame.result.placements) {
      const place = this.#places.get(p.id);
      if (!place || !p.placed) continue;
      seen.add(p.id);
      let dot = this.#dot.get(p.id);
      if (!dot) {
        dot = svg("circle", { r: place.capital ? 2.6 : 2, "stroke-width": place.capital ? 1.2 : 1 }, this.#dots);
        this.#dot.set(p.id, dot);
      }
      const [x, y] = this.#to(this.view, place.at);
      set(dot, { cx: f2(x), cy: f2(y), opacity: round(frame.opacity.get(p.id) ?? 1, 3) });
    }
    for (const [id, dot] of this.#dot) {
      if (seen.has(id)) continue;
      dot.remove();
      this.#dot.delete(id);
    }
  }

  hit(x: number, y: number): string | null {
    for (const id of this.#dot.keys()) {
      const [px, py] = this.#to(this.view, this.#places.get(id)!.at);
      if (Math.hypot(x - px, y - py) <= 6) return id;
    }
    const bx = (x - this.view.x) / this.view.k;
    const by = (y - this.view.y) / this.view.k;
    for (const c of this.#lands) {
      if (bx < c.bounds[0] || by < c.bounds[1] || bx > c.bounds[2] || by > c.bounds[3]) continue;
      for (const rings of c.shapes) {
        if (inRing(rings[0]!, bx, by) && !rings.slice(1).some((h) => h.length >= 3 && inRing(h, bx, by))) return c.id;
      }
    }
    return null;
  }

  info(id: string): Info | null {
    const place = this.#places.get(id);
    if (place) {
      const land = this.#byId.get(place.land);
      return { title: place.name, subtitle: land ? `${place.capital ? "Capital of" : "City in"} ${land.name}` : undefined };
    }
    const c = this.#byId.get(id);
    if (!c) return null;
    const capital = this.#places.get(`capital-${id}`)?.name;
    const rows: [string, string][] = [];
    if (capital) rows.push(["Capital", capital]);
    if (c.pop > 0) rows.push(["Population", compact(c.pop)]);
    if (c.gdp > 0) rows.push(["GDP", `US$${compact(c.gdp * 1e6)}`]);
    if (c.gdp > 0 && c.pop > 0) rows.push(["GDP per person", `US$${compact((c.gdp * 1e6) / c.pop)}`]);
    return { title: c.name, rows };
  }

  highlight(id: string | null): void {
    const layer = this.#stage.hover;
    layer.replaceChildren();
    if (id === null) return;
    const place = this.#places.get(id);
    if (place) {
      const [x, y] = this.#to(this.view, place.at);
      svg("circle", { cx: f2(x), cy: f2(y), r: 5.5, fill: "none", stroke: CITY_TEXT, "stroke-width": 1.5 }, layer);
      return;
    }
    const c = this.#byId.get(id);
    if (!c) return;
    const { k, x, y } = this.view;
    svg("path", {
      d: c.shapes.map(ringsPath).join(""),
      transform: `translate(${f2(x)} ${f2(y)}) scale(${round(k, 4)})`,
      fill: "#ffffff",
      "fill-opacity": 0.3,
      "fill-rule": "evenodd",
      stroke: "#4a4033",
      "stroke-width": 1.4,
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    }, layer);
  }
}
