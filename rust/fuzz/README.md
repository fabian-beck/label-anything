# Fuzzing

Coverage-guided fuzzing of the untrusted inputs with [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz)
(nightly Rust, libFuzzer). Targets: `place_json` (problem JSON → validate + place),
`svg_parse` (SVG backgrounds), `raster_decode` (PNG/JPEG/WebP). Every input must give a
result or a structured error, never a panic, an abort or a hang.

```sh
cargo install cargo-fuzz
rust/fuzz/seed.sh                       # corpora from conformance/
cd rust/fuzz && cargo +nightly fuzz run place_json -- -max_total_time=300 -rss_limit_mb=4096
```

CI runs each target for a few minutes weekly (`fuzz` job). A deterministic mutation test
over the same seeds runs on every build: `cargo test -p label-anything --test fuzz_smoke`
(`LA_FUZZ_CASES` sets the inputs per target).
