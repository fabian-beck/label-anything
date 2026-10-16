// A browser-like global environment (jsdom) for running the browser snippets in Node.
// Import it before anything else: libraries such as Leaflet look for `window` on import.
import { JSDOM, VirtualConsole } from "jsdom";

const virtualConsole = new VirtualConsole().sendTo(console, { omitJSDOMErrors: true });   // no "not implemented" noise
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true, virtualConsole });
const { window } = dom;
const names = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "SVGElement", "SVGSVGElement",
  "DOMParser", "XMLSerializer", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "HTMLDivElement", "Image", "screen", "devicePixelRatio", "location", "MutationObserver"];
for (const name of names) {
  const value = name === "window" ? window : window[name];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
