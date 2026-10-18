//! End-to-end tests of the `label-anything` binary: exit codes, messages on stderr and the
//! files it reads and writes.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_label-anything");

/// A fresh directory for one test, removed when dropped.
struct TempDir(PathBuf);

impl std::ops::Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn dir(name: &str) -> TempDir {
    let d = std::env::temp_dir().join(format!("la-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    TempDir(d)
}

/// Run the binary in `cwd` with `stdin`: (exit code, stdout, stderr).
fn run(cwd: &Path, args: &[&str], stdin: &str) -> (i32, String, String) {
    let mut child = Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let text = |b: Vec<u8>| String::from_utf8(b).unwrap();
    (
        out.status.code().unwrap_or(-1),
        text(out.stdout),
        text(out.stderr),
    )
}

fn point(id: &str, x: f64, y: f64, text: &str) -> Value {
    json!({"id": id, "anchor": {"type": "point", "x": x, "y": y}, "label": {"type": "text", "text": text}})
}

fn write(d: &Path, name: &str, v: &Value) {
    std::fs::write(d.join(name), v.to_string()).unwrap();
}

#[test]
fn flags_on_sections_of_the_wrong_type_are_invalid_problems() {
    let d = dir("wrong-types");
    let cases = [
        (json!({"solver": "fast"}), "--time", "/solver [type]"),
        (json!({"output": true}), "--debug-svg", "/output [type]"),
        (
            json!({"obstacles": []}),
            "--background",
            "/obstacles [type]",
        ),
        (
            json!({"priority": {"budget": 3}}),
            "--max-labels",
            "/priority/budget [type]",
        ),
        (
            json!({"defaults": {"font": "Arial"}}),
            "--font-size",
            "/defaults/font [type]",
        ),
    ];
    for (mut p, flag, expected) in cases {
        p["items"] = json!([point("a", 10.0, 10.0, "A")]);
        write(&d, "p.json", &p);
        let value = match flag {
            "--debug-svg" => "out.svg",
            "--background" => "bg.svg",
            _ => "3",
        };
        let (code, out, err) = run(&d, &["place", "p.json", flag, value], "");
        assert_eq!(code, 1, "{flag}: {err}");
        assert!(out.is_empty() && err.contains(expected), "{flag}: {err}");
    }
}

#[test]
fn malformed_json_is_an_invalid_problem() {
    let d = dir("malformed");
    let (code, _, err) = run(&d, &["place", "-"], "{items: []}");
    assert_eq!(code, 1);
    assert!(err.starts_with("error   / [parse] invalid JSON"), "{err}");
}

#[test]
fn background_is_relative_to_the_working_directory() {
    let d = dir("background");
    std::fs::create_dir_all(d.join("sub")).unwrap();
    write(
        &d,
        "sub/p.json",
        &json!({"items": [point("a", 30.0, 30.0, "A")]}),
    );
    std::fs::write(
        d.join("bg.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="50" height="50"/></svg>"#,
    )
    .unwrap();
    let (code, out, err) = run(&d, &["place", "sub/p.json", "--background", "bg.svg"], "");
    assert_eq!(code, 0, "{err}");
    let r: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(r["stats"]["grid"]["classes"], json!(["ink"]));
}

#[test]
fn canvas_flag_keeps_the_other_canvas_options() {
    let d = dir("canvas");
    let p = json!({"canvas": {"width": 100, "height": 100, "region": [0, 0, 300, 400]},
                   "items": [point("a", 295.0, 200.0, "Must stay left of x=300")]});
    write(&d, "p.json", &p);
    let (code, out, err) = run(&d, &["place", "p.json", "--canvas", "600x400"], "");
    assert_eq!(code, 0, "{err}");
    let r: Value = serde_json::from_str(&out).unwrap();
    let b = &r["placements"][0]["box"];
    assert!(
        b["x"].as_f64().unwrap() + b["w"].as_f64().unwrap() <= 300.0,
        "{b}"
    );
}

#[test]
fn place_prints_warnings_on_stderr() {
    let d = dir("warnings");
    let p = json!({"avoid": {"label": {"lnies": "hard"}}, "items": [point("a", 10.0, 10.0, "A")]});
    let (code, out, err) = run(&d, &["place", "-"], &p.to_string());
    assert_eq!(code, 0);
    assert_eq!(
        err,
        "warning /avoid/label/lnies [unknown_class] class 'lnies' is not produced by any obstacle source\n"
    );
    let r: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(r["warnings"][0]["code"], "unknown_class");
}

#[test]
fn render_checks_the_problem_and_the_result() {
    let d = dir("render");
    write(
        &d,
        "p.json",
        &json!({"canvas": {"width": 200, "height": 100}, "items": [point("a", 50.0, 50.0, "A")]}),
    );
    write(
        &d,
        "q.json",
        &json!({"items": [point("b", 50.0, 50.0, "B")]}),
    );
    write(
        &d,
        "bad.json",
        &json!({"items": [{"anchor": {"type": "point", "x": 1}}]}),
    );
    assert_eq!(run(&d, &["place", "p.json", "-o", "r.json"], "").0, 0);
    if cfg!(feature = "png") {
        assert_eq!(
            run(&d, &["render", "p.json", "r.json", "-o", "o.PNG"], "").0,
            0
        );
        assert!(std::fs::read(d.join("o.PNG"))
            .unwrap()
            .starts_with(b"\x89PNG"));
    }
    let (code, _, err) = run(&d, &["render", "bad.json", "r.json"], "");
    assert_eq!(code, 1);
    assert!(err.contains("/items/0/anchor/y [required]"), "{err}");
    let (code, out, err) = run(&d, &["render", "q.json", "r.json"], "");
    assert_eq!(code, 1);
    assert!(out.is_empty());
    assert_eq!(
        err,
        "label-anything: r.json is not a result of q.json: placement 0 is 'a', item 0 is 'b'\n"
    );
}

#[test]
fn csv_from_stdin_with_byte_order_mark() {
    let d = dir("csv");
    let csv = "\u{feff}name,x,y,pop\nA,10,10,5\n,20,20,7\nC,30,40,\n";
    let args = [
        "place",
        "--anchors",
        "-",
        "--labels-col",
        "name",
        "--priority-col",
        "pop",
    ];
    let (code, out, err) = run(&d, &args, csv);
    assert_eq!(code, 0, "{err}");
    let r: Value = serde_json::from_str(&out).unwrap();
    let ids: Vec<&str> = r["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["0", "2"]); // the row without a label is an obstacle
    assert_eq!(r["stats"]["grid"]["classes"], json!(["points"]));
    for (csv, message) in [
        (
            "x,y,label,pop\n1,2,A,1\n3,NaN,B,1\n",
            "row 3, column 'y': 'NaN' is not a finite number",
        ),
        (
            "x,y,label,pop\n1e400,2,A,1\n",
            "row 2, column 'x': '1e400' is not a finite number",
        ),
        (
            "x,y,label,pop\n1,2,A,big\n",
            "row 2, column 'pop': 'big' is not a finite number",
        ),
        (
            "name,x,y,pop\n",
            "no column 'label' (columns: name, x, y, pop); choose one with --labels-col",
        ),
    ] {
        let (code, _, err) = run(
            &d,
            &["place", "--anchors", "-", "--priority-col", "pop"],
            csv,
        );
        assert_eq!(
            (code, err),
            (1, format!("label-anything: stdin: {message}\n"))
        );
    }
}

#[test]
fn json_with_byte_order_mark() {
    let d = dir("bom");
    let p = format!(
        "\u{feff}{}",
        json!({"items": [point("a", 10.0, 10.0, "A")]})
    );
    std::fs::write(d.join("p.json"), p).unwrap();
    assert_eq!(run(&d, &["validate", "p.json"], "").0, 0);
    assert_eq!(run(&d, &["place", "p.json"], "").0, 0);
}

#[test]
fn font_errors_point_at_the_font_file() {
    let d = dir("font");
    std::fs::write(d.join("notafont.ttf"), "not a font").unwrap();
    let p = json!({"defaults": {"font": {"file": "notafont.ttf"}}, "items": [point("a", 10.0, 10.0, "A")]});
    let (code, _, err) = run(&d, &["place", "-"], &p.to_string());
    assert_eq!(code, 2);
    assert_eq!(
        err,
        "label-anything: /defaults/font/file invalid_value: invalid font: not a TrueType/OpenType font\n"
    );
}

#[test]
fn serve_answers_cors_preflight() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut server = Command::new(BIN)
        .args(["serve", "--port", &port.to_string()])
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let request = |text: &str| -> Option<String> {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        s.write_all(text.as_bytes()).ok()?;
        let mut out = String::new();
        s.read_to_string(&mut out).ok()?;
        Some(out)
    };
    let preflight = "OPTIONS /place HTTP/1.1\r\nHost: localhost\r\nOrigin: http://example.com\r\n\
                     Access-Control-Request-Method: POST\r\nConnection: close\r\n\r\n";
    let mut answer = None;
    for _ in 0..100 {
        answer = request(preflight);
        if answer.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = server.kill();
    let _ = server.wait();
    let answer = answer.expect("the server answers");
    assert!(answer.starts_with("HTTP/1.1 204"), "{answer}");
    assert!(
        answer.contains("Access-Control-Allow-Origin: *"),
        "{answer}"
    );
    assert!(
        answer.contains("Access-Control-Allow-Methods: POST, GET, OPTIONS"),
        "{answer}"
    );
    assert!(
        answer.contains("Access-Control-Allow-Headers: Content-Type"),
        "{answer}"
    );
}

/// Sends `text` to the server on `port` and returns its answer.
fn http(port: u16, text: &str) -> Option<String> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(60)))
        .ok()?;
    s.write_all(text.as_bytes()).ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    Some(out)
}

fn post(path: &str, body: &str) -> String {
    format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn serve_answers_while_a_request_is_in_progress() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut server = Command::new(BIN)
        .args(["serve", "--port", &port.to_string(), "--workers", "2"])
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let health = "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    let ready = (0..100).any(|_| {
        let up = http(port, health).is_some();
        if !up {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        up
    });
    // a crowded problem whose local search takes a while (100,000 moves)
    let items: Vec<Value> = (0..400)
        .map(|i| {
            point(
                &format!("i{i}"),
                10.0 + (i % 20) as f64 * 14.0,
                10.0 + (i / 20) as f64 * 14.0,
                &format!("Label {i}"),
            )
        })
        .collect();
    let slow = json!({"canvas": {"width": 300, "height": 300}, "items": items,
                      "solver": {"strategy": "local", "time_budget_ms": 1000}})
    .to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let place_tx = tx.clone();
    let slow_request = post("/place", &slow);
    let place = std::thread::spawn(move || {
        let answer = http(port, &slow_request);
        let _ = place_tx.send("place");
        answer
    });
    std::thread::sleep(std::time::Duration::from_millis(100));
    let during = http(port, health);
    let _ = tx.send("health");
    let first = rx.recv().unwrap();
    let placed = place.join().unwrap();
    let (bad_place, bad_validate) = (
        http(port, &post("/place", "{bad")),
        http(port, &post("/validate", "{bad")),
    );
    let _ = server.kill();
    let _ = server.wait();
    assert!(ready, "the server answers");
    assert!(placed.expect("a result").starts_with("HTTP/1.1 200"));
    assert!(during.expect("an answer").starts_with("HTTP/1.1 200"));
    assert_eq!(first, "health", "/health waited for the solve");
    // malformed JSON is an invalid problem: 422 from /place, a parse error from /validate
    let bad_place = bad_place.expect("an answer");
    assert!(bad_place.starts_with("HTTP/1.1 422"), "{bad_place}");
    let bad_validate = bad_validate.expect("an answer");
    assert!(bad_validate.starts_with("HTTP/1.1 200"), "{bad_validate}");
    assert!(
        bad_validate.contains("\"code\":\"parse\""),
        "{bad_validate}"
    );
}
