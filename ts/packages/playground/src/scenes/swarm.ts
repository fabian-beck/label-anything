/**
 * Moving objects: a flock (boids), a drift or orbits, each agent a labeled point. Labels
 * are solved warm-started several times per second while everything moves, and glide in
 * between; drag an agent to steer it.
 */
import { FONT_CLASSES, type Control } from "../controls.js";
import { nameGen, rng, type Obj } from "../util.js";
import type { Anchors, DrawState, Item, PointerInfo, Scene, SceneHost } from "./scene.js";

interface Agent {
  id: string;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Orbit: radius, angle, angular speed. */
  or: number;
  oa: number;
  ow: number;
}

type Behavior = "flock" | "drift" | "orbit";

export class SwarmScene implements Scene {
  readonly id = "swarm";
  readonly title = "Swarm";
  readonly hint = "Moving objects, re-labeled while they move. Drag one to steer it.";
  readonly about =
    "Up to 600 moving points, labeled many times a second: each solve starts from the previous labels (warm start), and the labels glide between solves. Turn the warm start off (Motion) to see them jump.";
  readonly credits = "Generated data.";
  readonly classes: readonly string[] = [];
  readonly animated = true;
  readonly cursor = "default" as const;
  readonly view = { budgetMoving: 10, maxRate: 30 };
  playing = false;
  readonly controls: Control[] = [
    { key: "count", label: "Objects", kind: "range", min: 10, max: 600, step: 10, format: (n) => String(n) },
    {
      key: "behavior", label: "Movement", kind: "segmented",
      options: [
        { value: "flock", label: "flock", title: "Boids: separation, alignment, cohesion" },
        { value: "drift", label: "drift", title: "Random walk" },
        { value: "orbit", label: "orbit", title: "Circular orbits, inner ones faster" },
      ],
    },
    { key: "leaders", label: "Leaders when crowded", kind: "toggle", hint: "Distant labels with straight leaders" },
  ];
  readonly params: Obj = { count: 120, behavior: "flock", leaders: true };

  #agents: Agent[] = [];
  #w = 800;
  #h = 600;
  #drag: Agent | null = null;
  #dragAt: [number, number] = [0, 0];
  #host!: SceneHost;

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
  }

  resize(w: number, h: number): void {
    const first = this.#agents.length === 0;
    const sx = w / this.#w;
    const sy = h / this.#h;
    this.#w = w;
    this.#h = h;
    if (first) this.#spawn();
    else for (const a of this.#agents) [a.x, a.y] = [a.x * sx, a.y * sy];
  }

  setParam(key: string, value: unknown): void {
    this.params[key] = value;
    if (key === "count" || key === "behavior") this.#spawn();
  }

  reset(): void {
    this.#spawn();
  }

  #spawn(): void {
    const n = Number(this.params.count);
    const r = rng(7);
    const name = nameGen(rng(11));
    const cx = this.#w / 2;
    const cy = this.#h / 2;
    const rmax = Math.min(this.#w, this.#h) * 0.46;
    this.#agents = Array.from({ length: n }, (_, i) => {
      const ang = r() * Math.PI * 2;
      const sp = 30 + r() * 30;
      const or = rmax * Math.sqrt(0.08 + 0.92 * r());
      const oa = r() * Math.PI * 2;
      return {
        id: `a${i}`,
        name: name(),
        x: 40 + r() * (this.#w - 80),
        y: 40 + r() * (this.#h - 80),
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        r: 2.5 + r() ** 2 * 5.5,
        or,
        oa,
        ow: (0.5 * (r() < 0.5 ? 1 : -0.6)) * (rmax / or) ** 1.5 * 0.25,
      };
    });
    if (this.params.behavior === "orbit") {
      for (const a of this.#agents) [a.x, a.y] = [cx + Math.cos(a.oa) * a.or, cy + Math.sin(a.oa) * a.or];
    }
    this.#host?.invalidate();
  }

  options() {
    const leaders = this.params.leaders === true;
    return {
      preset: "none" as const,
      placement: { models: (leaders ? ["adjacent", "slider", "distant"] : ["adjacent", "slider"]) as ("adjacent" | "slider" | "distant")[], max_distance: "5em" },
      leaders: { style: "straight" as const, max_length: "6em" },
      priority: { font_classes: FONT_CLASSES[1]!.value as never },
    };
  }

  items(): Item[] {
    return this.#agents.map((a) => ({
      id: a.id,
      anchor: { type: "point", x: round(a.x), y: round(a.y), mark: { shape: "circle", r: a.r } },
      label: { type: "text", text: a.name },
      priority: Math.round(a.r * 100) / 100,
    }));
  }

  obstacles() {
    return undefined;
  }

  anchors(): Anchors {
    return new Map(this.#agents.map((a) => [a.id, [round(a.x), round(a.y)]]));
  }

  step(dt: number): boolean {
    const s = dt / 1000;
    if (s <= 0) return false;
    const b = this.params.behavior as Behavior;
    if (b === "orbit") this.#orbit(s);
    else if (b === "drift") this.#drift(s);
    else this.#flock(s);
    return true;
  }

  #orbit(s: number): void {
    const cx = this.#w / 2;
    const cy = this.#h / 2;
    for (const a of this.#agents) {
      if (a === this.#drag) continue;
      a.oa += a.ow * s;
      a.x = cx + Math.cos(a.oa) * a.or;
      a.y = cy + Math.sin(a.oa) * a.or;
    }
  }

  #drift(s: number): void {
    const r = Math.random;
    for (const a of this.#agents) {
      if (a === this.#drag) continue;
      a.vx += (r() - 0.5) * 120 * s - a.vx * 0.4 * s;
      a.vy += (r() - 0.5) * 120 * s - a.vy * 0.4 * s;
      this.#move(a, s);
    }
  }

  #flock(s: number): void {
    const cell = 60;
    const grid = new Map<number, Agent[]>();
    const key = (x: number, y: number) => Math.floor(x / cell) * 4096 + Math.floor(y / cell);
    for (const a of this.#agents) {
      const k = key(a.x, a.y);
      const list = grid.get(k);
      if (list) list.push(a);
      else grid.set(k, [a]);
    }
    for (const a of this.#agents) {
      if (a === this.#drag) continue;
      let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, n = 0;
      const gx = Math.floor(a.x / cell);
      const gy = Math.floor(a.y / cell);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const o of grid.get((gx + i) * 4096 + gy + j) ?? []) {
            if (o === a) continue;
            const dx = o.x - a.x;
            const dy = o.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > cell * cell) continue;
            n++;
            ax += o.vx;
            ay += o.vy;
            cx += o.x;
            cy += o.y;
            if (d2 < 22 * 22) {
              const d = Math.sqrt(d2) || 1;
              sx -= (dx / d) * (22 - d);
              sy -= (dy / d) * (22 - d);
            }
          }
        }
      }
      if (n) {
        a.vx += ((ax / n - a.vx) * 0.6 + (cx / n - a.x) * 0.5 + sx * 4) * s;
        a.vy += ((ay / n - a.vy) * 0.6 + (cy / n - a.y) * 0.5 + sy * 4) * s;
      }
      if (this.#drag) {
        // flee a little from the dragged one
        const dx = a.x - this.#drag.x;
        const dy = a.y - this.#drag.y;
        const d = Math.hypot(dx, dy);
        if (d < 90 && d > 0) {
          a.vx += (dx / d) * 160 * s;
          a.vy += (dy / d) * 160 * s;
        }
      }
      const sp = Math.hypot(a.vx, a.vy);
      const lo = 25;
      const hi = 70;
      if (sp < lo || sp > hi) {
        const f = (sp < lo ? lo : hi) / (sp || 1);
        a.vx *= f;
        a.vy *= f;
      }
      this.#move(a, s);
    }
  }

  #move(a: Agent, s: number): void {
    const m = 30;
    if (a.x < m) a.vx += (m - a.x) * 4 * s;
    if (a.x > this.#w - m) a.vx -= (a.x - this.#w + m) * 4 * s;
    if (a.y < m) a.vy += (m - a.y) * 4 * s;
    if (a.y > this.#h - m) a.vy -= (a.y - this.#h + m) * 4 * s;
    a.x = Math.min(this.#w - 4, Math.max(4, a.x + a.vx * s));
    a.y = Math.min(this.#h - 4, Math.max(4, a.y + a.vy * s));
  }

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    if (layer === "background") {
      if (this.params.behavior === "orbit") {
        ctx.save();
        ctx.strokeStyle = "rgba(120, 130, 150, 0.18)";
        ctx.lineWidth = 1;
        const cx = this.#w / 2;
        const cy = this.#h / 2;
        for (const a of this.#agents) {
          ctx.beginPath();
          ctx.arc(cx, cy, a.or, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#e0b04c";
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    ctx.save();
    for (const a of this.#agents) {
      const on = state.hover === a.id || state.selected === a.id || this.#drag === a;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#3949ab" : state.placed.has(a.id) ? "#6f7d96" : "#b7bfcc";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    ctx.restore();
  }

  hit(x: number, y: number): string | null {
    let best: Agent | null = null;
    let bd = Infinity;
    for (const a of this.#agents) {
      const d = Math.hypot(a.x - x, a.y - y) - a.r;
      if (d < 6 && d < bd) [best, bd] = [a, d];
    }
    return best?.id ?? null;
  }

  pointerDown(p: PointerInfo): boolean {
    const id = this.hit(p.x, p.y);
    const a = this.#agents.find((q) => q.id === id);
    if (!a) return false;
    this.#drag = a;
    this.#dragAt = [p.x - a.x, p.y - a.y];
    return true;
  }

  pointerMove(p: PointerInfo): void {
    const a = this.#drag;
    if (!a) return;
    const nx = p.x - this.#dragAt[0];
    const ny = p.y - this.#dragAt[1];
    a.vx = (nx - a.x) * 20;
    a.vy = (ny - a.y) * 20;
    a.x = nx;
    a.y = ny;
    if (this.params.behavior === "orbit") {
      const cx = this.#w / 2;
      const cy = this.#h / 2;
      a.or = Math.max(20, Math.hypot(a.x - cx, a.y - cy));
      a.oa = Math.atan2(a.y - cy, a.x - cx);
    }
    this.#host.moved();
  }

  pointerUp(): void {
    this.#drag = null;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
