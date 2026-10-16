# Bundled fonts

| File | Purpose |
|---|---|
| `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf` | Latin/Greek/Cyrillic subset **with outlines**, used for rendering (PNG output of `label-anything render`, examples). |
| `NotoSans-Regular.metrics.ttf`, `NotoSans-Bold.metrics.ttf` | The same subset with glyph outlines removed. Embedded by `la-text` (Rust/WASM) and `@label-anything/text` (TypeScript) for measurement only. |

All four files are derived from **Noto Sans 2.015** (Copyright 2022 The Noto Project
Authors) and are licensed under the **SIL Open Font License 1.1** (see `OFL.txt`).
"Noto" is a trademark of Google LLC; the subsets keep the original family name as the
OFL permits for unmodified glyph data (no Reserved Font Name is declared for Noto Sans).

The subsets are reproducible with `tools/fonts/subset.py` (fonttools 4.60.1). Coverage:
Basic Latin, Latin-1, Latin Extended-A/B and Additional, combining marks, Greek (incl.
extended), Cyrillic (incl. supplement), general punctuation (incl. `…`), currency,
letterlike symbols, number forms, arrows, math operators, geometric shapes. Kept layout
features: `kern, liga, clig, calt, ccmp, locl, mark, mkmk, dist, case, frac, sups, subs`.

SHA-256:

```
4d0d22644fecabefb64b805e606f036b87194ea6663121e68121a9f27e10b5ee  NotoSans-Regular.ttf
6a8dab103163cd5b176e70296cad0a3335f9b43cd248543d9aea011bff452650  NotoSans-Bold.ttf
31f8c2d0fcf5ec0ecfe83a0715a734794c93885073615a94bb27a23117efc248  NotoSans-Regular.metrics.ttf
8e41c5fc9b0bcf7823fd80ac777f16d730b1aadcfae6d1c43650b2a9620221d3  NotoSans-Bold.metrics.ttf
```
