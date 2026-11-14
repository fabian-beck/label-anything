/** Entry point: the scenes, the app, the bundled label font. */
import { App } from "./app.js";
import { loadLabelFont } from "./render.js";
import type { Scene } from "./scenes/scene.js";
import { LinesScene } from "./scenes/lines.js";
import { MapScene } from "./scenes/map.js";
import { NetworkScene } from "./scenes/network.js";
import { PictureScene } from "./scenes/picture.js";
import { ScatterScene } from "./scenes/scatter.js";
import { SwarmScene } from "./scenes/swarm.js";

async function main(): Promise<void> {
  await loadLabelFont();
  const scenes: Scene[] = [new MapScene(), new NetworkScene(), new ScatterScene(), new LinesScene(), new SwarmScene(), new PictureScene()];
  const app = new App(scenes, new URL(".", import.meta.url));
  (globalThis as unknown as { playground: App }).playground = app;
  await app.start();
}

void main();
