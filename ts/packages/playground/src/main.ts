/** Entry point: the scenes, the app, the bundled label font. */
import { App } from "./app.js";
import type { Scene } from "./scenes/scene.js";
import { LinesScene } from "./scenes/lines.js";
import { MapScene } from "./scenes/map.js";
import { NetworkScene } from "./scenes/network.js";
import { PictureScene } from "./scenes/picture.js";
import { ScatterScene } from "./scenes/scatter.js";
import { SwarmScene } from "./scenes/swarm.js";

async function main(): Promise<void> {
  // the label font must be ready before the first frame: the engine measures with it
  await Promise.all([
    document.fonts.load('400 12px "LA Noto Sans"'),
    document.fonts.load('700 12px "LA Noto Sans"'),
  ]).catch(() => undefined);
  const scenes: Scene[] = [new MapScene(), new NetworkScene(), new ScatterScene(), new LinesScene(), new SwarmScene(), new PictureScene()];
  const app = new App(scenes, new URL(".", import.meta.url));
  (globalThis as unknown as { playground: App }).playground = app;
  await app.start();
}

void main();
