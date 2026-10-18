/**
 * The Code tab: the problem of the latest solve, and how to solve it elsewhere — the same
 * JSON gives the same layout in JavaScript, Python, the CLI (the engine is deterministic).
 */
import type { App } from "../app.js";
import type { Obj } from "../util.js";
import { copyText, download, h } from "./dom.js";

type Lang = "json" | "options" | "js" | "python" | "cli";

const LANGS: { id: Lang; label: string }[] = [
  { id: "json", label: "Problem" },
  { id: "options", label: "Options only" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
  { id: "cli", label: "CLI" },
];

export class CodeView {
  #root: HTMLElement;
  #app: App;
  #lang: Lang = "json";

  constructor(root: HTMLElement, app: App) {
    this.#root = root;
    this.#app = app;
  }

  update(): void {
    const problem = this.#app.problem as unknown as Obj | undefined;
    if (!problem) {
      this.#root.replaceChildren(h("div", { class: "code" }, h("p", { class: "empty" }, "The problem appears after the first solve.")));
      return;
    }
    const full = cleanProblem(problem);
    const options = { ...full };
    delete options.items;
    delete options.warm_start;
    delete options.obstacles;
    const items = (full.items as unknown[]).length;
    const text = this.#text(full, options);
    const pre = h("pre", {}, h("code", {}, truncate(text, 60000)));
    const tabs = h(
      "div",
      { class: "seg", role: "group", "aria-label": "Format" },
      LANGS.map((l) => h("button", { type: "button", "aria-pressed": String(l.id === this.#lang), onclick: () => { this.#lang = l.id; this.update(); } }, l.label)),
    );
    const copied = h("span", { class: "empty grow" });
    const copy = h("button", {
      class: "btn primary", type: "button",
      onclick: async () => {
        copied.textContent = (await copyText(text, pre)) ? "Copied." : "Selected: press Ctrl+C.";
        setTimeout(() => (copied.textContent = ""), 2500);
      },
    }, "Copy");
    const save = h("button", { class: "btn", type: "button", onclick: () => download(this.#lang === "python" ? "label.py" : this.#lang === "js" ? "label.mjs" : this.#lang === "cli" ? "label.sh" : "problem.json", text, "text/plain") }, "Download");
    const note =
      this.#lang === "options"
        ? "The options of this solve, without items, obstacles and warm start: what to pass besides your own data."
        : `The problem of the latest solve: ${items} items${full.obstacles ? ", obstacles" : ""}${full.warm_start ? ", without its warm start" : ""}. Solved anywhere, it gives this layout.`;
    this.#root.replaceChildren(h("div", { class: "code" }, tabs, h("p", { class: "empty", style: { margin: 0 } }, note), h("div", { class: "row" }, copy, save, copied), pre));
  }

  #text(full: Obj, options: Obj): string {
    const json = JSON.stringify(full, null, 1);
    switch (this.#lang) {
      case "json":
        return json;
      case "options":
        return JSON.stringify(options, null, 2);
      case "js":
        return [
          `// npm install @label-anything/wasm   (or @label-anything/core: pure TypeScript, same API)`,
          `import { init, place } from "@label-anything/wasm";`,
          ``,
          `await init();`,
          `const problem = ${JSON.stringify(options, null, 2).replace(/\n/g, "\n")};`,
          `problem.items = myItems; // [{ id, anchor: { type: "point", x, y, mark }, label: { type: "text", text } }, ...]`,
          `const result = place(problem);`,
          `for (const p of result.placements) if (p.placed) draw(p.box, p.text, p.leader);`,
        ].join("\n");
      case "python":
        return [
          `# pip install label-anything`,
          `from pathlib import Path`,
          `import label_anything as la`,
          ``,
          `result = la.place_problem(Path("problem.json"))   # the "Problem" tab, saved`,
          `print(result)   # <Result placed=... hard_violations=0 ...>`,
          `for p in result.placements:`,
          `    if p.placed:`,
          `        print(p.id, p.box)`,
        ].join("\n");
      case "cli":
        return [
          `# save the "Problem" tab as problem.json, then`,
          `label-anything place problem.json -o result.json`,
          `label-anything render problem.json result.json -o labels.svg   # debug drawing`,
        ].join("\n");
    }
  }
}

/** The problem without its warm start (large, and specific to this session's previous frame). */
function cleanProblem(p: Obj): Obj {
  const out: Obj = { ...p };
  delete out.warm_start;
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString("en-US")} more characters: Copy or Download gives everything)`;
}
