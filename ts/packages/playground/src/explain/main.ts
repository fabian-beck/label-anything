/** Entry point of the explainer page: the bundled label font, the scenes, the app. */
import { ExplainApp } from "./app.js";
import { scenes } from "./scenes.js";

async function main(): Promise<void> {
  // the label font must be ready before the first drawing: the engine measures with it
  await Promise.all([document.fonts.load('400 12px "LA Noto Sans"'), document.fonts.load('700 12px "LA Noto Sans"')]).catch(() => undefined);
  const app = new ExplainApp(scenes(), new URL(".", import.meta.url));
  (globalThis as unknown as { explainer: ExplainApp }).explainer = app;
  await app.start();
}

void main();
