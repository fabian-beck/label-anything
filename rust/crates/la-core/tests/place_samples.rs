//! Runs `place` on the conformance sample problems that need no SVG backend and checks
//! the hard guarantees.
use label_anything_core::env::BasicEnv;
use label_anything_core::place;
use serde_json::Value;
use std::path::Path;

fn problems() -> Vec<(String, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/problems");
    let mut v: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    v.sort();
    v.into_iter()
        .map(|p| {
            (
                p.file_stem().unwrap().to_string_lossy().into_owned(),
                serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap(),
            )
        })
        .filter(|(_, p): &(String, Value)| {
            p.pointer("/obstacles/svg").is_none()
        })
        .collect()
}

#[test]
fn samples_place_without_violations() {
    for (name, p) in problems() {
        let r = place(&p, &BasicEnv).unwrap_or_else(|e| panic!("{name}: {e}"));
        let st = &r["stats"];
        assert_eq!(st["hard_violations"], 0, "{name}");
        assert_eq!(st["priority_inversions"], 0, "{name}");
        assert_eq!(st["leader_crossings"], 0, "{name}");
        let r2 = place(&p, &BasicEnv).unwrap();
        assert_eq!(
            r["placements"], r2["placements"],
            "{name}: not deterministic"
        );
        eprintln!("{name}: placed {}/{}", st["placed"], st["total"]);
    }
}
