# Scenario 06 — data license

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| OpenStreetMap extract of Monaco (`monaco-latest.osm.pbf`, Geofabrik extract via osmium) | `onthegomap/planetiler@7a5e0c59…` `planetiler-core/src/test/resources/` | Open Database License (ODbL) 1.0 | "© OpenStreetMap contributors" |

The extract is downloaded by `fetch.py` (SHA-256 verified) and never committed. The
raster map in the generated problems is a *Produced Work* rendered by `osmmap.py`
(map style by Label Anything, loosely following OSM Carto colors); any publication of
it or of figures made from it must show **"© OpenStreetMap contributors"** and refer to
the ODbL (<https://www.openstreetmap.org/copyright>).
