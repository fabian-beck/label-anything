/**
 * @label-anything/extras — Label Anything helpers for visualization libraries.
 *
 * Library adapters live in subpath modules so that each pulls in only what it needs:
 * `@label-anything/extras/d3`, `/vega`, `/plot`, `/leaflet`, `/maplibre`, `/cytoscape`,
 * `/sigma` and `/worker`. This entry point exports the shared building blocks.
 */
export { LatestRunner, resolveEngine, setDefaultEngine, type AnyEngine, type AsyncEngine, type Engine } from "./engine.js";
export { canvasMeasure, cssFont, type CssFont, type MeasureFn } from "./measure.js";
export { buildProblem, resolveFont, type FontOptions, type LabelOptions, type LeaderStyle } from "./options.js";
export { followAnchors, leaderPath, renderLabels, type RenderOptions } from "./render.js";
export { LabelMemory } from "./stable.js";
export { Overlay, type OverlayConfig, type OverlayItem } from "./overlay.js";
export { snapshotSvg, type SnapshotOptions, type SvgSnapshot } from "./svg.js";
