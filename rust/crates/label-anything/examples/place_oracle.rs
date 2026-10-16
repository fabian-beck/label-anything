//! Parity oracle: solves every problem of the conformance suite with a clockless
//! environment and writes the results to `conformance/parity/<name>.json`, which the
//! TypeScript port must reproduce exactly (`ts/packages/core/test/parity.test.ts`).
//!
//! ```text
//! cargo run --release -p label-anything --example place_oracle            # write
//! cargo run --release -p label-anything --example place_oracle -- --check # verify
//! ```
//!
//! Without a clock (`now_ms() = 0`, as `BasicEnv`) there is no deadline: the iteration
//! budgets alone decide, so results are fully deterministic. Every problem of
//! `conformance/problems/` becomes `<stem>.json` with a `problem_file`; every
//! `conformance/place/` case with an inline problem becomes `place-<stem>.json` with the
//! problem embedded (cases that reference a file under `problems/` are covered by that
//! file's fixture). The stored result drops the fields that depend on the clock or name
//! the implementation: `stats.runtime_ms`, `stats.phases_ms`, `stats.implementation`.

use label_anything::{Env, NativeEnv, SvgBackend};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The native environment without its clock.
struct Clockless(NativeEnv);

impl Env for Clockless {
    fn svg(&self) -> Option<&dyn SvgBackend> {
        self.0.svg()
    }
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        self.0.read_file(path)
    }
    fn now_ms(&self) -> f64 {
        0.0
    }
    fn has_measure_callback(&self) -> bool {
        false
    }
}

fn read_json(p: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))
}

fn json_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    v.sort();
    Ok(v)
}

/// The result with the clock- and implementation-dependent fields removed.
fn oracle_result(problem: &Value, base: &Path) -> Result<Value, String> {
    let env = Clockless(NativeEnv::with_base_dir(base));
    let mut r = label_anything::place_with(problem, &env).map_err(|e| e.to_string())?;
    if let Some(st) = r.get_mut("stats").and_then(|s| s.as_object_mut()) {
        // shift_remove keeps the order of the other keys
        st.shift_remove("runtime_ms");
        st.shift_remove("phases_ms");
        st.shift_remove("implementation");
    }
    Ok(r)
}

fn stem(p: &Path) -> String {
    p.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// All fixtures as (file name, pretty JSON text).
fn fixtures(conf: &Path) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let problems = conf.join("problems");
    for p in json_files(&problems)? {
        let problem = read_json(&p)?;
        let name = stem(&p);
        let result = oracle_result(&problem, &problems).map_err(|e| format!("{name}: {e}"))?;
        let doc = json!({
            "kind": "parity",
            "problem_file": format!("../problems/{name}.json"),
            "result": result,
        });
        out.push((format!("{name}.json"), pretty(&doc)?));
    }
    let place = conf.join("place");
    for p in json_files(&place)? {
        let case = read_json(&p)?;
        let Some(problem) = case.get("problem") else {
            continue; // a problem file of problems/: covered by its own fixture
        };
        let name = format!("place-{}", stem(&p));
        let result = oracle_result(problem, &place).map_err(|e| format!("{name}: {e}"))?;
        let doc = json!({
            "kind": "parity",
            "problem": problem,
            "result": result,
        });
        out.push((format!("{name}.json"), pretty(&doc)?));
    }
    Ok(out)
}

fn pretty(v: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(v)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}

fn run() -> Result<bool, String> {
    let mut check = false;
    let mut conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance");
    for a in std::env::args().skip(1) {
        if a == "--check" {
            check = true;
        } else {
            conf = PathBuf::from(a);
        }
    }
    let dir = conf.join("parity");
    let want = fixtures(&conf)?;
    if check {
        let mut ok = true;
        for (name, text) in &want {
            match std::fs::read_to_string(dir.join(name)) {
                Ok(have) if have == *text => {}
                Ok(_) => {
                    eprintln!("stale: conformance/parity/{name}");
                    ok = false;
                }
                Err(_) => {
                    eprintln!("missing: conformance/parity/{name}");
                    ok = false;
                }
            }
        }
        for p in json_files(&dir).unwrap_or_default() {
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !want.iter().any(|(n, _)| *n == name) {
                eprintln!("extra: conformance/parity/{name}");
                ok = false;
            }
        }
        if ok {
            eprintln!("{} parity fixtures are current", want.len());
        } else {
            eprintln!("run: cargo run --release -p label-anything --example place_oracle");
        }
        return Ok(ok);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for p in json_files(&dir)? {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    for (name, text) in &want {
        std::fs::write(dir.join(name), text).map_err(|e| format!("{name}: {e}"))?;
    }
    eprintln!("wrote {} parity fixtures to {}", want.len(), dir.display());
    Ok(true)
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("place_oracle: {e}");
            ExitCode::from(2)
        }
    }
}
