# Scenario 08 — data licenses

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| `astronaut.png` (Eileen Collins) | scikit-image 0.26.0 sdist (PyPI), SHA-256 `f5f970ab…199fa`, `src/skimage/data/` | Public domain (NASA) | NASA Great Images database. |
| `retina.jpg` (fundus photograph, normal left eye) | same | CC0 1.0 | Mikael Häggström, "Medical gallery of Mikael Häggström 2014", WikiJournal of Medicine 1(2), doi:10.15347/wjm/2014.008. |
| `rocket.jpg` (DSCOVR on Falcon 9, SLC-40) | same | Public domain (released by SpaceX) | SpaceX Photos. |
| `polygons.json` (annotation polygons) | this repository | CC0 1.0 | Hand-made by the Label Anything contributors. |

The sdist (BSD-3-Clause package) is downloaded by `fetch.py`; only the three images are
read from it. Problems embed the images re-encoded as JPEG (quality 90).
