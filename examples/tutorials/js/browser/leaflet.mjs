// Leaflet (docs/tutorials/interactive-maps.md): a label layer re-solved after every pan and
// zoom, warm-started from the previous result. Checked by ../browser-checks.mjs.
// --8<-- [start:leaflet]
import { labelLayer } from "@label-anything/extras/leaflet";

// L: the Leaflet namespace (import L from "leaflet"), map: an L.Map
export function addCityLabels(L, map, cities) {
  return labelLayer(L, cities, {
    latLng: (d) => [d.lat, d.lon],
    text: (d) => d.name,
    id: (d) => d.id,                           // stable ids: labels keep their places
    priority: (d) => d.population,             // the same priority on every zoom level: labels nest
    mark: { shape: "icon", w: 25, h: 41 },     // Leaflet's default marker pin (tip on the point)
    font: { family: "sans-serif", size: 12 },
  }).addTo(map);
}
// --8<-- [end:leaflet]
