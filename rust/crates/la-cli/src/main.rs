//! `label-anything` command-line interface (brief §6.5).
//!
//! ```text
//! label-anything place problem.json -o result.json [--debug-svg out.svg] [--time 200] [--seed 1]
//! label-anything place --anchors pts.csv --labels-col name --priority-col traffic --omission prefix \
//!                      --background bg.png --preset map -o out.json
//! label-anything render problem.json result.json -o overlay.svg
//! label-anything validate problem.json
//! label-anything bench [--suite full|quick] [--baselines] [--perf] [--gate] [--previous old.json] -o bench-report/ [-- ARGS]
//! label-anything serve --port 7077
//! ```
//! `-` reads stdin / writes stdout.

mod csv;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use clap::{Parser, Subcommand};
use label_anything::{Env, NativeEnv, Report};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "label-anything",
    version,
    about = "Label placement engine: place labels and leaders avoiding obstacles, with priority-driven omission."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // parsed once per process
enum Cmd {
    /// Solve a problem (JSON) or build one from a CSV of anchors.
    Place {
        /// Problem JSON file, or `-` for stdin. Omit when using --anchors.
        problem: Option<String>,
        /// Output result file (`-` = stdout, the default).
        #[arg(short, long, default_value = "-")]
        output: String,
        /// Also write the debug SVG overlay.
        #[arg(long)]
        debug_svg: Option<PathBuf>,
        /// Time budget in ms (solver.time_budget_ms).
        #[arg(long)]
        time: Option<f64>,
        /// Random seed (solver.seed).
        #[arg(long)]
        seed: Option<u64>,
        /// Pretty-print the result.
        #[arg(long)]
        pretty: bool,
        /// CSV file with anchors (columns x, y and a label column).
        #[arg(long)]
        anchors: Option<PathBuf>,
        #[arg(long, default_value = "x")]
        x_col: String,
        #[arg(long, default_value = "y")]
        y_col: String,
        #[arg(long, default_value = "label")]
        labels_col: String,
        #[arg(long)]
        id_col: Option<String>,
        #[arg(long)]
        priority_col: Option<String>,
        /// strict | prefix | weighted
        #[arg(long)]
        omission: Option<String>,
        /// Background file: .svg or a raster image (.png/.jpg/.webp).
        #[arg(long)]
        background: Option<PathBuf>,
        #[arg(long)]
        preset: Option<String>,
        /// Canvas as WxH (CSV mode; default from the background or the anchors).
        #[arg(long)]
        canvas: Option<String>,
        #[arg(long)]
        font_size: Option<f64>,
        #[arg(long)]
        max_labels: Option<u64>,
        /// Solve without a clock (no wall-clock guards; deterministic, for parity tests).
        #[arg(long, hide = true)]
        no_clock: bool,
        /// Solve this many times before the reported solve (steady-state timing, as in a
        /// host application that solves repeatedly).
        #[arg(long, default_value_t = 0)]
        warmup: u32,
    },
    /// Render the debug overlay of a problem and a result.
    Render {
        problem: String,
        result: String,
        #[arg(short, long, default_value = "-")]
        output: String,
    },
    /// Validate a problem.
    Validate {
        problem: String,
        /// Print the report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Run the real-world benchmark (delegates to bench/run.py with this binary as the `rust` solver).
    ///
    /// Python: $LA_BENCH_PYTHON, else bench/.venv's interpreter when present, else python3.
    /// Arguments after `--` are passed to bench/run.py unchanged.
    Bench {
        #[arg(long, default_value = "quick")]
        suite: String,
        /// Also run the baselines (naive, greedy, textalloc, adjustText, vega-label, ggrepel).
        #[arg(long)]
        baselines: bool,
        /// Measure the performance targets.
        #[arg(long)]
        perf: bool,
        /// Evaluate the release gates (implies --perf); the exit code reflects them.
        #[arg(long)]
        gate: bool,
        /// results.json of the previous release (changes and the regression gate).
        #[arg(long)]
        previous: Option<PathBuf>,
        /// Runs per problem.
        #[arg(long)]
        runs: Option<u32>,
        #[arg(short, long, default_value = "bench-report")]
        output: PathBuf,
        /// Repository root (defaults to the nearest ancestor containing bench/run.py).
        #[arg(long)]
        repo: Option<PathBuf>,
        /// Further arguments for bench/run.py (after `--`).
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// HTTP server: POST /place and POST /validate with a JSON body.
    Serve {
        #[arg(long, default_value_t = 7077)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },
}

/// An environment without a clock (`now_ms() = 0`): no wall-clock guards, so results
/// depend only on the iteration budgets (`place --no-clock`, used by parity tests).
struct Clockless<'a>(&'a NativeEnv);

impl Env for Clockless<'_> {
    fn svg(&self) -> Option<&dyn label_anything::SvgBackend> {
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

fn read_input(path: &str) -> Result<String, String> {
    if path == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| format!("stdin: {e}"))?;
        Ok(s)
    } else {
        std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
    }
}

fn write_output(path: &str, data: &str) -> Result<(), String> {
    if path == "-" {
        let mut out = std::io::stdout().lock();
        out.write_all(data.as_bytes())
            .and_then(|_| out.write_all(b"\n"))
            .map_err(|e| e.to_string())
    } else {
        std::fs::write(path, data).map_err(|e| format!("{path}: {e}"))
    }
}

fn env_for(path: Option<&str>) -> NativeEnv {
    match path
        .filter(|p| *p != "-")
        .and_then(|p| Path::new(p).parent().map(|d| d.to_path_buf()))
    {
        Some(d) if !d.as_os_str().is_empty() => NativeEnv::with_base_dir(d),
        _ => NativeEnv::new(),
    }
}

fn print_report(r: &Report) {
    for e in &r.errors {
        eprintln!(
            "error   {} [{}] {}",
            if e.pointer.is_empty() {
                "/"
            } else {
                &e.pointer
            },
            e.code,
            e.message
        );
    }
    for w in &r.warnings {
        eprintln!("warning {} [{}] {}", w.pointer, w.code, w.message);
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("label-anything: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, String> {
    match cli.cmd {
        Cmd::Place {
            problem,
            output,
            debug_svg,
            time,
            seed,
            pretty,
            anchors,
            x_col,
            y_col,
            labels_col,
            id_col,
            priority_col,
            omission,
            background,
            preset,
            canvas,
            font_size,
            max_labels,
            no_clock,
            warmup,
        } => {
            let (mut p, env) = match (&problem, &anchors) {
                (Some(path), None) => {
                    let text = read_input(path)?;
                    let v: Value = serde_json::from_str(&text)
                        .map_err(|e| format!("{path}: invalid JSON: {e}"))?;
                    (v, env_for(Some(path)))
                }
                (None, Some(csv_path)) => {
                    let opts = csv::CsvOpts {
                        x_col,
                        y_col,
                        labels_col,
                        id_col,
                        priority_col,
                    };
                    let v = csv::problem_from_csv(csv_path, &opts)?;
                    (v, NativeEnv::new())
                }
                (Some(_), Some(_)) => {
                    return Err("give either a problem file or --anchors, not both".into())
                }
                (None, None) => return Err("missing problem file (or --anchors)".into()),
            };
            let obj = p
                .as_object_mut()
                .ok_or("the problem must be a JSON object")?;
            if let Some(t) = time {
                obj.entry("solver").or_insert(json!({}))["time_budget_ms"] = json!(t);
            }
            if let Some(s) = seed {
                obj.entry("solver").or_insert(json!({}))["seed"] = json!(s);
            }
            if let Some(o) = omission {
                obj.entry("priority").or_insert(json!({}))["omission"] = json!(o);
            }
            if let Some(m) = max_labels {
                let pr = obj.entry("priority").or_insert(json!({}));
                pr.as_object_mut()
                    .ok_or("priority must be an object")?
                    .entry("budget")
                    .or_insert(json!({}))["max_labels"] = json!(m);
            }
            if let Some(ps) = preset {
                obj.insert("preset".into(), json!(ps));
            }
            if let Some(fs) = font_size {
                obj.entry("defaults")
                    .or_insert(json!({}))
                    .as_object_mut()
                    .ok_or("defaults must be an object")?
                    .entry("font")
                    .or_insert(json!({}))["size"] = json!(fs);
            }
            if let Some(c) = canvas {
                let (w, h) = c.split_once(['x', 'X']).ok_or("--canvas must be WxH")?;
                obj.insert("canvas".into(), json!({"width": w.parse::<f64>().map_err(|e| e.to_string())?, "height": h.parse::<f64>().map_err(|e| e.to_string())?}));
            }
            if let Some(bg) = background {
                let ext = bg
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let path = bg.to_string_lossy().into_owned();
                let o = obj.entry("obstacles").or_insert(json!({}));
                if ext == "svg" {
                    o["svg"] = json!({"path": path});
                } else {
                    o["raster"] = json!({"source": path});
                }
            }
            if debug_svg.is_some() {
                obj.entry("output").or_insert(json!({}))["debug_svg"] = json!(true);
            }
            let report = label_anything::validate(&p);
            if !report.valid {
                print_report(&report);
                return Ok(ExitCode::from(1));
            }
            let clockless = Clockless(&env);
            let env: &dyn Env = if no_clock { &clockless } else { &env };
            for _ in 0..warmup {
                label_anything::place_validated(&p, env, label_anything::validate(&p))
                    .map_err(|e| e.to_string())?;
            }
            let mut result =
                label_anything::place_validated(&p, env, report).map_err(|e| e.to_string())?;
            if let Some(path) = debug_svg {
                if let Some(svg) = result.get("debug_svg").and_then(|s| s.as_str()) {
                    std::fs::write(&path, svg).map_err(|e| format!("{}: {e}", path.display()))?;
                }
                result["debug_svg"] = Value::Null;
            }
            let text = if pretty {
                serde_json::to_string_pretty(&result)
            } else {
                serde_json::to_string(&result)
            }
            .map_err(|e| e.to_string())?;
            write_output(&output, &text)?;
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Render {
            problem,
            result,
            output,
        } => {
            let p: Value = serde_json::from_str(&read_input(&problem)?)
                .map_err(|e| format!("{problem}: {e}"))?;
            let r: Value = serde_json::from_str(&read_input(&result)?)
                .map_err(|e| format!("{result}: {e}"))?;
            let env = env_for(Some(&problem));
            let svg = label_anything::render_svg(&p, &r, &env);
            if output.ends_with(".png") {
                let png = svg_to_png(&svg)?;
                std::fs::write(&output, png).map_err(|e| format!("{output}: {e}"))?;
                return Ok(ExitCode::SUCCESS);
            }
            write_output(&output, &svg)?;
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Validate { problem, json } => {
            let text = read_input(&problem)?;
            let report = match serde_json::from_str::<Value>(&text) {
                Ok(v) => label_anything::validate(&v),
                Err(e) => Report {
                    valid: false,
                    errors: vec![label_anything::Issue::new(
                        "",
                        "parse",
                        format!("invalid JSON: {e}"),
                    )],
                    warnings: vec![],
                },
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                print_report(&report);
                if report.valid {
                    eprintln!("valid");
                }
            }
            Ok(if report.valid {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Cmd::Bench {
            suite,
            baselines,
            perf,
            gate,
            previous,
            runs,
            output,
            repo,
            args,
        } => {
            let root = match repo {
                Some(r) => r,
                None => {
                    let mut d = std::env::current_dir().map_err(|e| e.to_string())?;
                    loop {
                        if d.join("bench/run.py").exists() {
                            break d;
                        }
                        if !d.pop() {
                            return Err("bench/run.py not found; pass --repo".into());
                        }
                    }
                }
            };
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let python = std::env::var_os("LA_BENCH_PYTHON")
                .map(PathBuf::from)
                .or_else(|| {
                    [
                        root.join("bench/.venv/bin/python"),
                        root.join("bench/.venv/Scripts/python.exe"),
                    ]
                    .into_iter()
                    .find(|p| p.exists())
                })
                .unwrap_or_else(|| PathBuf::from("python3"));
            let mut cmd = std::process::Command::new(&python);
            cmd.arg(root.join("bench/run.py"))
                .arg("--suite")
                .arg(&suite)
                .arg("--out")
                .arg(&output)
                .arg("--engine")
                .arg(exe);
            if baselines {
                cmd.arg("--baselines");
            }
            if perf {
                cmd.arg("--perf");
            }
            if gate {
                cmd.arg("--gate");
            }
            if let Some(p) = previous {
                cmd.arg("--previous").arg(p);
            }
            if let Some(n) = runs {
                cmd.arg("--runs").arg(n.to_string());
            }
            cmd.args(&args);
            let status = cmd
                .status()
                .map_err(|e| format!("{}: {e}", python.display()))?;
            Ok(if status.success() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Cmd::Serve { port, host } => serve(&host, port),
    }
}

fn serve(host: &str, port: u16) -> Result<ExitCode, String> {
    let server = tiny_http::Server::http((host, port)).map_err(|e| e.to_string())?;
    eprintln!("label-anything serving on http://{host}:{port} (POST /place, POST /validate)");
    for mut req in server.incoming_requests() {
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let json_header =
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static header");
        let cors = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..])
            .expect("static header");
        let (status, text) = match (req.method(), req.url()) {
            (tiny_http::Method::Post, "/place") => match label_anything::place_json(&body) {
                Ok(r) => (200, r),
                Err(e) => (422, format!("{{\"errors\":{e}}}")),
            },
            (tiny_http::Method::Post, "/validate") => match serde_json::from_str::<Value>(&body) {
                Ok(v) => (200, serde_json::to_string(&label_anything::validate(&v)).unwrap_or_default()),
                Err(e) => (400, json!({"valid": false, "errors": [{"pointer": "", "code": "parse", "message": e.to_string()}]}).to_string()),
            },
            (tiny_http::Method::Get, "/") | (tiny_http::Method::Get, "/health") => {
                (200, json!({"name": "label-anything", "version": label_anything::VERSION}).to_string())
            }
            _ => (404, json!({"error": "not found"}).to_string()),
        };
        let resp = tiny_http::Response::from_string(text)
            .with_status_code(status)
            .with_header(json_header)
            .with_header(cors);
        let _ = req.respond(resp);
    }
    Ok(ExitCode::SUCCESS)
}

/// Rasterize an SVG (the debug overlay) to PNG with the bundled Noto Sans.
#[cfg(feature = "png")]
fn svg_to_png(svg: &str) -> Result<Vec<u8>, String> {
    use resvg::{tiny_skia, usvg};
    let mut opt = usvg::Options::default();
    let fonts = opt.fontdb_mut();
    fonts.load_font_data(include_bytes!("../assets/NotoSans-Regular.ttf").to_vec());
    fonts.load_font_data(include_bytes!("../assets/NotoSans-Bold.ttf").to_vec());
    fonts.set_sans_serif_family("Noto Sans");
    let tree =
        usvg::Tree::from_str(svg, &opt).map_err(|e| format!("cannot render the SVG: {e}"))?;
    let size = tree.size().to_int_size();
    let mut pixmap =
        tiny_skia::Pixmap::new(size.width(), size.height()).ok_or("the image is empty")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap
        .encode_png()
        .map_err(|e| format!("cannot encode the PNG: {e}"))
}

#[cfg(not(feature = "png"))]
fn svg_to_png(_svg: &str) -> Result<Vec<u8>, String> {
    Err("PNG output needs the `png` feature of label-anything-cli; write .svg instead".into())
}
