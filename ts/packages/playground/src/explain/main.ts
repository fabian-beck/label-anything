/** Entry point of the explainer page: the bundled label font, the scenes, the app. */
import { loadLabelFont } from "../render.js";
import { ExplainApp } from "./app.js";
import { scenes } from "./scenes.js";

async function main(): Promise<void> {
  await loadLabelFont();
  const app = new ExplainApp(scenes(), new URL(".", import.meta.url));
  (globalThis as unknown as { explainer: ExplainApp }).explainer = app;
  await app.start();
}

void main();
