# Scenario 05 — data licenses

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| `airports.dat`, `routes.dat` | `jpatokal/openflights@56a3cce4…` `data/` | Open Database License (ODbL) 1.0; contents under the Database Contents License (DbCL) 1.0 | "Contains information from OpenFlights.org, which is made available under the Open Database License (ODbL)." |
| Admin-0 countries, 1:50m | `nvkelso/natural-earth-vector@ca96624a…` `geojson/ne_50m_admin_0_countries.geojson` | Public domain | "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com." |
| Breakaway and disputed areas, 1:50m (the outlines that `bench/common/borders.py` gives back to the countries they belong to) | `nvkelso/natural-earth-vector@ca96624a…` `geojson/ne_50m_admin_0_breakaway_disputed_areas.geojson` | Public domain | as above |

The files are downloaded by `fetch.py` (SHA-256 verified) and never committed. Problems,
truths and backgrounds derived from them are *Produced Works* under the ODbL: when you
publish them (or figures made from them), keep the OpenFlights attribution above. The
SVG backgrounds already contain the credit line "Data: OpenFlights (ODbL) · Natural Earth".
Scenarios 10, 11 and 12 derive from the same data and carry the same obligations.
