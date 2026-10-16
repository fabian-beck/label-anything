//! The committed geometry fixture (`conformance/geometry/core-geometry.json`) must equal
//! the output of the oracle (`examples/geom_oracle.rs`), so that the TypeScript port is
//! always checked against the current Rust behaviour.

#[path = "../examples/geom_oracle.rs"]
#[allow(dead_code)]
mod oracle;

#[test]
fn geometry_fixture_is_current() {
    let want = oracle::generate();
    let have = std::fs::read_to_string(oracle::fixture_path()).unwrap_or_default();
    assert!(
        have == want,
        "{} is stale: regenerate it with `cargo run -p label-anything-core --example geom_oracle` (from rust/)",
        oracle::FIXTURE
    );
}
