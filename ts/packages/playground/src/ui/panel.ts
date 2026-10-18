/**
 * The Options tab: one collapsible section per topic, each control showing the value in
 * effect and whether the user changed it (a dot, and a reset link).
 */
import type { Choice, Control, RangeControl, Section } from "../controls.js";
import { deepEqual } from "../util.js";
import { h } from "./dom.js";

export interface PanelModel {
  /** The value in effect for a key. */
  get(key: string): unknown;
  /** Whether the user set this key (it differs from the scene's value). */
  changed(key: string): boolean;
  set(key: string, value: unknown): void;
  reset(key: string): void;
  /** Problem paths are shown under their names; view and scene keys are not. */
  isProblemKey(key: string): boolean;
  /** Status of the extra JSON (null: fine). */
  jsonStatus(): { ok: boolean; text: string } | null;
}

interface Bound {
  control: Control;
  el: HTMLElement;
  update(): void;
}

export class Panel {
  #bound: Bound[] = [];
  #counts = new Map<string, HTMLElement>();
  #sectionKeys = new Map<string, string[]>();
  #root: HTMLElement;
  #model: PanelModel;
  #open = new Map<string, boolean>();

  constructor(root: HTMLElement, model: PanelModel) {
    this.#root = root;
    this.#model = model;
  }

  render(sections: Section[], toolbar: HTMLElement): void {
    this.#bound = [];
    this.#counts.clear();
    this.#sectionKeys.clear();
    const parts: HTMLElement[] = [toolbar];
    for (const s of sections) {
      const body = h("div", { class: "body" });
      if (s.about) body.appendChild(h("p", { class: "about" }, s.about));
      if (s.note) body.appendChild(h("p", { class: "note" }, s.note));
      for (const c of s.controls) {
        const b = this.#control(c);
        this.#bound.push(b);
        body.appendChild(b.el);
      }
      const count = h("span", { class: "count", hidden: true });
      this.#counts.set(s.id, count);
      this.#sectionKeys.set(s.id, s.controls.map((c) => c.key));
      const details = h("details", { class: "section", "data-section": s.id }, h("summary", {}, s.title, count), body);
      details.open = this.#open.get(s.id) ?? s.open ?? false;
      details.addEventListener("toggle", () => this.#open.set(s.id, details.open));
      parts.push(details);
    }
    this.#root.replaceChildren(...parts);
    this.update();
  }

  /** Refresh every control from the model (values, changed marks, visibility). */
  update(): void {
    const get = (k: string) => this.#model.get(k);
    for (const b of this.#bound) {
      b.el.hidden = b.control.when ? !b.control.when(get) : false;
      b.el.classList.toggle("changed", this.#model.changed(b.control.key));
      b.update();
    }
    for (const [id, keys] of this.#sectionKeys) {
      const n = keys.filter((k) => this.#model.changed(k)).length;
      const el = this.#counts.get(id)!;
      el.hidden = n === 0;
      el.textContent = `${n} changed`;
    }
  }

  #head(c: Control, val?: HTMLElement): HTMLElement {
    const reset = h("button", { class: "reset", type: "button", title: "Back to the scene's value", onclick: () => this.#model.reset(c.key) }, "reset");
    return h(
      "div",
      { class: "head" },
      h("span", { class: "name" }, c.label),
      this.#model.isProblemKey(c.key) ? h("span", { class: "key", title: c.key }, c.key) : null,
      val ?? null,
      reset,
    );
  }

  #control(c: Control): Bound {
    const m = this.#model;
    switch (c.kind) {
      case "select": {
        const sel = h("select", { "aria-label": c.label }) as HTMLSelectElement;
        c.options.forEach((o, i) => sel.appendChild(h("option", { value: String(i), title: o.title }, o.label)));
        const custom = h("option", { value: "custom", disabled: true }, "custom (Problem JSON)");
        sel.appendChild(custom);
        sel.addEventListener("change", () => {
          const o = c.options[Number(sel.value)];
          if (o) m.set(c.key, o.value);
        });
        const el = h("div", { class: "ctl" }, this.#head(c), sel, c.hint ? h("div", { class: "hint" }, c.hint) : null);
        return { control: c, el, update: () => { sel.value = choiceIndex(c.options, m.get(c.key)); } };
      }
      case "segmented": {
        const buttons = c.options.map((o) =>
          h("button", { type: "button", title: o.title, onclick: () => m.set(c.key, o.value) }, o.label),
        );
        const el = h("div", { class: "ctl" }, this.#head(c), h("div", { class: "seg", role: "group", "aria-label": c.label }, buttons), c.hint ? h("div", { class: "hint" }, c.hint) : null);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            c.options.forEach((o, i) => buttons[i]!.setAttribute("aria-pressed", String(deepEqual(o.value, v))));
          },
        };
      }
      case "range": {
        const val = h("span", { class: "val" });
        const input = h("input", { type: "range", min: String(sliderMin(c)), max: String(sliderMax(c)), step: c.log ? "any" : String(c.step), "aria-label": c.label }) as HTMLInputElement;
        input.addEventListener("input", () => {
          const n = fromSlider(c, Number(input.value));
          val.textContent = (c.format ?? String)(n);
          m.set(c.key, c.encode ? c.encode(n) : n);
        });
        const el = h("div", { class: "ctl" }, this.#head(c, val), input, c.hint ? h("div", { class: "hint" }, c.hint) : null);
        return {
          control: c,
          el,
          update: () => {
            const raw = m.get(c.key);
            const n = c.decode ? c.decode(raw) : typeof raw === "number" ? raw : c.min;
            if (document.activeElement !== input) input.value = String(toSlider(c, n));
            val.textContent = (c.format ?? String)(n);
          },
        };
      }
      case "toggle": {
        // `null` is a value here (e.g. defaults.wrap off), not a missing one
        const on = "on" in c ? c.on : true;
        const off = "off" in c ? c.off : false;
        const box = h("input", { type: "checkbox" }) as HTMLInputElement;
        box.addEventListener("change", () => m.set(c.key, box.checked ? on : off));
        const label = h("label", { class: "toggle" }, h("span", {}, c.hint ?? ""), box);
        const el = h("div", { class: "ctl" }, this.#head(c), label);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            box.checked = v !== undefined && v !== null && v !== false && !deepEqual(v, off);
          },
        };
      }
      case "checks": {
        const boxes = c.options.map((o) => {
          const box = h("input", { type: "checkbox", value: String(o.value) }) as HTMLInputElement;
          box.addEventListener("change", () => {
            const values = c.options.filter((_, i) => boxes[i]!.box.checked).map((q) => q.value);
            m.set(c.key, values);
          });
          return { box, el: h("label", { title: o.title }, box, o.label) };
        });
        const el = h("div", { class: "ctl" }, this.#head(c), h("div", { class: "checks" }, boxes.map((b) => b.el)), c.hint ? h("div", { class: "hint" }, c.hint) : null);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            const list = Array.isArray(v) ? v : [];
            c.options.forEach((o, i) => (boxes[i]!.box.checked = list.some((x) => deepEqual(x, o.value))));
          },
        };
      }
      case "avoid": {
        const modes: Choice[] = [
          { value: "hard", label: "hard" },
          { value: "soft", label: "soft" },
          { value: "ignore", label: "ignore" },
        ];
        const val = h("span", { class: "val" });
        const slider = h("input", { type: "range", min: "0", max: "4", step: "0.05", "aria-label": `${c.label}: weight` }) as HTMLInputElement;
        const buttons = modes.map((o) =>
          h("button", {
            type: "button",
            onclick: () => {
              if (o.value === "soft") m.set(c.key, softValue(m.get(c.key)));
              else m.set(c.key, o.value);
            },
          }, o.label),
        );
        slider.addEventListener("input", () => {
          const n = Math.round(Number(slider.value) * 100) / 100;
          val.textContent = String(n);
          m.set(c.key, n);
        });
        const el = h("div", { class: "ctl" }, this.#head(c, val), h("div", { class: "seg" }, buttons), slider);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            const mode = typeof v === "number" ? "soft" : v === "ignore" ? "ignore" : "hard";
            modes.forEach((o, i) => buttons[i]!.setAttribute("aria-pressed", String(o.value === mode)));
            slider.hidden = mode !== "soft";
            val.textContent = mode === "soft" ? String(v) : "";
            if (typeof v === "number" && document.activeElement !== slider) slider.value = String(v);
          },
        };
      }
      case "text": {
        const input = h("input", { type: "text", "aria-label": c.label, placeholder: c.placeholder ?? "" }) as HTMLInputElement;
        input.addEventListener("input", () => m.set(c.key, input.value));
        const el = h("div", { class: "ctl" }, this.#head(c), input, c.hint ? h("div", { class: "hint" }, c.hint) : null);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            if (document.activeElement !== input) input.value = typeof v === "string" ? v : "";
          },
        };
      }
      case "json": {
        const area = h("textarea", { spellcheck: false, "aria-label": c.label, placeholder: '{ "placement": { "slider_per_quadrant": 8 } }' }) as HTMLTextAreaElement;
        const status = h("div", { class: "status" });
        let timer = 0;
        area.addEventListener("input", () => {
          clearTimeout(timer);
          timer = window.setTimeout(() => m.set(c.key, area.value), 350);
        });
        const el = h("div", { class: "ctl json-edit" }, this.#head(c), area, status);
        return {
          control: c,
          el,
          update: () => {
            const v = m.get(c.key);
            if (document.activeElement !== area) area.value = typeof v === "string" ? v : "";
            const s = m.jsonStatus();
            status.textContent = s?.text ?? "";
            status.className = `status ${s ? (s.ok ? "ok" : "err") : ""}`;
          },
        };
      }
    }
  }
}

function softValue(v: unknown): number {
  return typeof v === "number" ? v : 1;
}

function choiceIndex(options: Choice[], v: unknown): string {
  const i = options.findIndex((o) => deepEqual(o.value, v));
  return i >= 0 ? String(i) : "custom";
}

function sliderMin(c: RangeControl): number {
  return c.log ? Math.log(c.min) : c.min;
}
function sliderMax(c: RangeControl): number {
  return c.log ? Math.log(c.max) : c.max;
}
function toSlider(c: RangeControl, n: number): number {
  return c.log ? Math.log(Math.max(c.min, n)) : n;
}
function fromSlider(c: RangeControl, s: number): number {
  if (!c.log) return s;
  const v = Math.exp(s);
  // round to the step, keeping 2 significant digits for small values
  const step = v < 10 ? 0.5 : v < 100 ? 1 : 5;
  return Math.max(c.min, Math.min(c.max, Math.round(v / step) * step));
}
