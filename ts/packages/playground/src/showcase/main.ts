/**
 * The live examples of the documentation's home page: a figure marked
 * `data-la-example="economies|europe|retina|modules"` shows its static picture until this
 * script has solved the example in the browser, then the live drawing takes its place
 * (./stage.ts). Each example starts when it comes near the viewport.
 *
 * Built into dist/showcase.js; the home page loads it from the playground's directory and
 * solves with the playground's TypeScript engine (engine-ts.js) in a worker. Without it
 * (e.g. under `mkdocs serve`) the static figures stay.
 */
import type { LabelProblem } from "@label-anything/core";
import { createWorkerEngine, type WorkerEngine } from "@label-anything/extras/worker";
import { Economies, type WorldCountry } from "./economies.js";
import { Europe } from "./europe.js";
import { Modules } from "./modules.js";
import { Retina, pixelsOf, type Picture } from "./retina.js";
import { Stage, type Example } from "./stage.js";
import { fetchJson } from "./util.js";

const at = (path: string): URL => new URL(path, import.meta.url);

let world: Promise<WorldCountry[]> | undefined;
const loadWorld = (): Promise<WorldCountry[]> => (world ??= fetchJson<{ countries: WorldCountry[] }>(at("data/world.json")).then((d) => d.countries));

const EXAMPLES: Record<string, () => Promise<Example>> = {
  economies: async () => new Economies(await loadWorld()),
  europe: async () => new Europe(await loadWorld()),
  modules: async () => new Modules(await fetchJson<LabelProblem>(at("data/showcase/modules.json"))),
  retina: async () => {
    const image = at("data/pictures/retina.jpg").href;
    const [base, pictures, pixels] = await Promise.all([
      fetchJson<LabelProblem>(at("data/showcase/retina.json")),
      fetchJson<{ pictures: Picture[] }>(at("data/pictures/pictures.json")),
      pixelsOf(image),
    ]);
    return new Retina(base, pictures.pictures.find((p) => p.id === "retina")!, pixels, image);
  },
};

let fonts: Promise<void> | undefined;
/** The bundled Noto Sans, regular and bold: what the engine measures with. */
function loadFonts(): Promise<void> {
  return (fonts ??= (async () => {
    try {
      const faces = [
        new FontFace("LA Noto Sans", `url(${at("fonts/NotoSans-Regular.ttf").href})`, { weight: "400" }),
        new FontFace("LA Noto Sans", `url(${at("fonts/NotoSans-Bold.ttf").href})`, { weight: "700" }),
      ];
      for (const f of faces) document.fonts.add(f);
      await Promise.race([Promise.all(faces.map((f) => f.load())), new Promise((ok) => setTimeout(ok, 4000))]);
    } catch {
      // drawn with a fallback font: the boxes fit the text a little less well
    }
  })());
}

export interface Showcase {
  stages: Record<string, Stage>;
  examples: Record<string, Example>;
}

/** Starts the live examples of the page, each when it comes near the viewport. */
export function start(doc: Document = document): Showcase | undefined {
  const figures = [...doc.querySelectorAll<HTMLElement>("[data-la-example]")].filter((f) => (f.dataset.laExample ?? "") in EXAMPLES);
  if (!figures.length || typeof Worker === "undefined") return undefined;
  const showcase: Showcase = { stages: {}, examples: {} };
  let engine: WorkerEngine | undefined;
  const boot = async (figure: HTMLElement) => {
    const name = figure.dataset.laExample!;
    try {
      const [example] = await Promise.all([EXAMPLES[name]!(), loadFonts()]);
      engine ??= createWorkerEngine(() => new Worker(at("engine-ts.js"), { type: "module", name: "label-anything-showcase" }));
      showcase.examples[name] = example;
      showcase.stages[name] = new Stage(figure, example, engine);
    } catch (e) {
      console.warn(`label-anything example ${name}:`, e); // the static figure stays
    }
  };
  if (typeof IntersectionObserver === "undefined") {
    for (const f of figures) void boot(f);
  } else {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          seen.unobserve(e.target);
          void boot(e.target as HTMLElement);
        }
      },
      { rootMargin: "600px 0px" },
    );
    for (const f of figures) seen.observe(f);
  }
  (globalThis as { labelAnythingShowcase?: Showcase }).labelAnythingShowcase = showcase;
  return showcase;
}

start();
