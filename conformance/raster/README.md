# `raster` cases

Language-neutral tests of raster backgrounds (spec §4.6): decoding, background
estimation, the five pixel modes, area averaging, quantization and dilation. Expected
values are produced by the Rust implementation; **every implementation must reproduce
the coverage arrays byte for byte** (spec §1: *identical*).

Runners:

* Rust: `cargo test -p label-anything-raster --test conformance` (from `rust/`)
* TypeScript: `npx vitest run packages/raster` (from `ts/`)

Regenerate (images, then expectations from the Rust oracle
`rust/crates/la-raster/examples/raster_oracle.rs`) with
`python3 tools/raster/make_conformance.py`; `--check` fails if any file would change.
Images live in `images/` (PNG, each well below 50 KB) and are painted deterministically
by that script with its own PNG encoder (`tools/raster/pngenc.py`), so they cover
encodings other tools do not write (16-bit RGB, Adam7, every filter and deflate block
type, odd chunk layouts, corrupt files).

## Case format

One JSON object per file:

```jsonc
{
  "kind": "raster",
  "name": "ink: anti-aliased strokes ...",
  "image": { "file": "images/strokes-rgb8.png" },   // or one of the forms below
  "decode": { "width": 64, "height": 40, "rgba_fnv1a32": "ff20c8f8" },  // or { "error": "corrupt_image" }
  "background": [255, 255, 255],                     // estimate_background(image)
  "runs": [
    {
      "name": "defaults (auto background, threshold 0.12, dilate 1), cell 2",
      "mode": { "kind": "ink", "background": null, "threshold": 0.12, "dilate": 1 },
      "class": "ink",                                // absent for classmap
      "placement": { "scale": 1, "offset": [0, 0] },
      "grid": { "origin": [0, 0], "cell": 2, "cols": 32, "rows": 20 },
      "expect": [
        { "class": "ink", "fnv1a32": "1911bd06", "sum": 84215, "nonzero": 372,
          "coverage": "<base64 of rows*cols bytes>" }   // or "samples": [[col, row, value], …]
      ]
    }
  ],
  "oklab":  [ { "rgb": [255, 0, 0], "lab": [0.6279553606145516, 0.22486306106597398, 0.1258462985307351],
               "lab_bits": ["3fe41835d725ff10", "3fccc85012adabec", "3fc01bbb44418e76"] } ],
  "hex":    [ { "input": "#abc", "rgb": [170, 187, 204] }, { "input": "abc", "rgb": null } ],
  "base64": [ { "input": "TQ", "hex": "4d" }, { "input": "T", "error": "invalid_base64" } ]
}
```

Every section is optional; a runner checks all that are present.

### `image`

| form | meaning |
|---|---|
| `{"file": "images/x.png"}` | file bytes (relative to this directory) → `decode` |
| `{"source": "data:…"}` | `decode_source` (data URL, base64 or percent-encoded) |
| `{"base64": "…"}` | `decode_source` of bare base64 |
| `{"rgba": {"width": w, "height": h, "data": "<base64>"}}` | `rgba_from_base64` |

`decode` holds the decoded size and the FNV-1a (32 bit, offset basis `0x811c9dc5`,
prime `0x01000193`, 8 lowercase hex digits) of the RGBA8 bytes, or the expected error
code (`invalid_base64`, `invalid_data_url`, `unsupported_format`, `corrupt_image`,
`invalid_dimensions`, `limit_exceeded`). Error cases have no `runs`. Synchronous decoding
must succeed for every case here (only PNG files are used; JPEG/WebP decoding is tested
per implementation).

### `runs`

`mode` mirrors the API (`Mode` in Rust and TypeScript):

| kind | fields |
|---|---|
| `ink` | `background` (`null` = estimate, or `#rrggbb`), `threshold`, `dilate` |
| `alpha` | `threshold` |
| `cost` | `invert` |
| `classmap` | `palette` (`[["#rrggbb" or "#rgb", class], …]` in document order), `tolerance`, `unmatched_ink`, `background`, `ink_threshold` |
| `saliency` | — |

`placement` is `RasterPlacement` (`scale` raster px per canvas px, `offset` = canvas
position of the raster's top-left corner) and `grid` is `GridSpec`.

`expect` lists the returned classes **in order** (for `classmap`: classes with any
coverage in palette order, then `ink`). Each entry has the FNV-1a, the sum and the
number of non-zero cells of the coverage array, plus either the complete array
(`coverage`, base64, for grids up to 4096 cells) or `samples` (`[col, row, value]`).

### `oklab`, `hex`, `base64`

`oklab` compares `srgb_to_oklab` exactly: `lab_bits` are the IEEE-754 binary64 bit
patterns (16 hex digits, big-endian) and are authoritative (`lab` is informative; JSON
parsers are not all correctly rounded). `hex` checks `parse_hex_color` (`null` = invalid),
`base64` checks `decode_base64` (bytes as hex, or an error code).

### Numbers

Numeric inputs are written so that every JSON parser reads them exactly (integer
significand below 2^53, decimal exponent at most 22; the generator enforces this).
