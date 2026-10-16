// MapLibre GL / Mapbox GL (docs/tutorials/interactive-maps.md): an SVG label overlay that
// follows the map and avoids rendered features of chosen layers. Checked by
// ../browser-checks.mjs (with a stand-in map: MapLibre needs WebGL).
// --8<-- [start:maplibre]
import { labelMapLibre } from "@label-anything/extras/maplibre";

// map: a maplibregl.Map after its "load" event
export function addStationLabels(map, stations) {
  return labelMapLibre(map, stations, {
    lngLat: (d) => [d.lon, d.lat],
    text: (d) => d.name,
    id: (d) => d.id,
    priority: (d) => d.passengers,
    avoidLayers: ["roads", "rivers"],                    // rendered features become obstacles
    avoid: { label: { roads: 0.5, rivers: "hard" } },    // classes = layer ids
  });
}
// --8<-- [end:maplibre]
