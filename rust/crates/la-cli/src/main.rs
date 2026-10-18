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
//! `-` reads stdin / writes stdout. Exit codes: 0 success, 1 invalid problem or input, 2
//! any other error.

mod csv;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use clap::{Parser, Subcommand};
use label_anything::{Env, Issue, NativeEnv, Report};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "label-anything",
    version,
    about = "Label placement engine: place labels and leaders avoiding obstacles, with priority-driven omission.",
    after_help = "Files: `-` reads stdin / writes stdout.\n\
                  Exit codes: 0 success, 1 invalid problem or input (errors on stderr), 2 any other error."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)] // parsed once per process
enum Cmd {
    /// Solve a problem (JSON) or build one from a CSV of anchors.
    ///
    /// Validation errors and warnings go to stderr. The problem options below set the
    /// field named in parentheses, in a JSON problem as well as in a CSV one.
    Place {
        /// Problem JSON file, or `-` for stdin. Omit when using --anchors.
        problem: Option<String>,
        /// Output result file (`-` = stdout, the default).
        #[arg(short, long, default_value = "-")]
        output: String,
        /// Also write the debug SVG overlay (with heatmaps and candidates).
        #[arg(long)]
        debug_svg: Option<PathBuf>,
        /// Pretty-print the result.
        #[arg(long)]
        pretty: bool,
        /// Solve this many times before the reported solve (steady-state timing, as in a
        /// host application that solves repeatedly).
        #[arg(long, default_value_t = 0)]
        warmup: u32,
        /// Solve without a clock (no wall-clock guards; deterministic, for parity tests).
        #[arg(long, hide = true)]
        no_clock: bool,

        /// Time budget in ms (solver.time_budget_ms).
        #[arg(long, allow_negative_numbers = true, help_heading = "Problem options")]
        time: Option<f64>,
        /// Random seed (solver.seed).
        #[arg(long, help_heading = "Problem options")]
        seed: Option<u64>,
        /// Solver strategy (solver.strategy); greedy skips the local search.
        #[arg(long, value_parser = ["auto", "greedy", "local", "exact"], help_heading = "Problem options")]
        strategy: Option<String>,
        /// Degradation ladder, comma-separated steps (degrade), e.g. `wrap,distant,omit`;
        /// `omit` alone turns the ladder off.
        #[arg(long, value_delimiter = ',', help_heading = "Problem options")]
        degrade: Option<Vec<String>>,
        /// Preset (preset).
        #[arg(long, value_parser = ["auto", "scatter", "map", "graph", "illustration", "none"], help_heading = "Problem options")]
        preset: Option<String>,
        /// Canvas size as WxH, e.g. 800x600 (canvas.width and canvas.height; the other canvas
        /// options are kept). Without a canvas: the background's size, else unbounded.
        #[arg(long, value_name = "WxH", value_parser = parse_canvas, help_heading = "Problem options")]
        canvas: Option<(f64, f64)>,
        /// Background file, relative to the current directory: .svg (obstacles.svg) or a
        /// raster image .png/.jpg/.webp (obstacles.raster).
        #[arg(long, help_heading = "Problem options")]
        background: Option<PathBuf>,
        /// Default font size in px (defaults.font.size).
        #[arg(long, allow_negative_numbers = true, help_heading = "Problem options")]
        font_size: Option<f64>,
        /// Place at most this many labels, in priority order (priority.budget.max_labels).
        #[arg(long, help_heading = "Problem options")]
        max_labels: Option<u64>,
        /// Omission mode (priority.omission).
        #[arg(long, value_parser = ["strict", "prefix", "weighted"], help_heading = "Problem options")]
        omission: Option<String>,

        /// CSV file with anchors, or `-` for stdin: one item per row, with x, y and label
        /// columns; the other columns become attrs (numbers where they parse as numbers).
        #[arg(long, help_heading = "CSV input")]
        anchors: Option<String>,
        /// Column of the x coordinates.
        #[arg(long, default_value = "x", help_heading = "CSV input")]
        x_col: String,
        /// Column of the y coordinates.
        #[arg(long, default_value = "y", help_heading = "CSV input")]
        y_col: String,
        /// Column of the label texts; rows with an empty label get no label (their points
        /// become obstacles of class `points`).
        #[arg(long, default_value = "label", help_heading = "CSV input")]
        labels_col: String,
        /// Column of the item ids [default: the row index, from 0].
        #[arg(long, help_heading = "CSV input")]
        id_col: Option<String>,
        /// Column of the item priorities (numbers; an empty cell leaves the item without one).
        #[arg(long, help_heading = "CSV input")]
        priority_col: Option<String>,
    },
    /// Render the debug overlay of a problem and a result.
    ///
    /// The problem is validated, and the result must be one of this problem (one placement
    /// per item, in order). Without heatmaps and candidates (those exist only during the
    /// solve: `place --debug-svg`).
    Render {
        /// Problem JSON file, or `-` for stdin.
        problem: String,
        /// Result JSON file of this problem (from `place`), or `-` for stdin.
        result: String,
        /// Output file: SVG, or PNG when it ends in .png (rasterized with the bundled Noto
        /// Sans); `-` writes the SVG to stdout.
        #[arg(short, long, default_value = "-")]
        output: String,
    },
    /// Validate a problem; exit code 1 when it is invalid.
    ///
    /// Errors and warnings go to stderr, the report with --json to stdout. Files referenced
    /// by the problem (backgrounds, fonts) are read only by `place`.
    Validate {
        /// Problem JSON file, or `-` for stdin.
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
        /// Problem suite: quick or full.
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
        /// Report directory.
        #[arg(short, long, default_value = "bench-report")]
        output: PathBuf,
        /// Repository root (defaults to the nearest ancestor containing bench/run.py).
        #[arg(long)]
        repo: Option<PathBuf>,
        /// Further arguments for bench/run.py (after `--`).
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// HTTP server: POST /place and POST /validate with a JSON body, GET /health.
    ///
    /// Relative file paths in problems resolve against the working directory. Problems may
    /// read files only when the server listens on a loopback address, or with --allow-files.
    Serve {
        /// Port to listen on.
        #[arg(long, default_value_t = 7077)]
        port: u16,
        /// Address to listen on (127.0.0.1: this machine only; 0.0.0.0: every interface).
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Let problems read files (backgrounds, fonts) also on a non-loopback --host.
        #[arg(long)]
        allow_files: bool,
        /// Requests solved at the same time [default: the number of CPUs].
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
        workers: Option<u16>,
    },
}

/// Why a command failed.
enum Failure {
    /// An invalid problem: its errors (exit code 1).
    Invalid(Vec<Issue>),
    /// Another invalid input, e.g. a CSV or a result (exit code 1).
    Input(String),
    /// Anything else (exit code 2).
    Other(String),
}

impl From<String> for Failure {
    fn from(e: String) -> Failure {
        Failure::Other(e)
    }
}

/// `--canvas WxH`.
fn parse_canvas(s: &str) -> Result<(f64, f64), String> {
    s.split_once(['x', 'X'])
        .and_then(|(w, h)| Some((w.trim().parse().ok()?, h.trim().parse().ok()?)))
        .ok_or_else(|| "expected WxH, e.g. 800x600".to_string())
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

/// Read a text input (`-` = stdin), without a leading UTF-8 byte order mark.
fn read_input(path: &str) -> Result<String, String> {
    let mut s = String::new();
    if path == "-" {
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| format!("stdin: {e}"))?;
    } else {
        s = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    }
    if s.starts_with('\u{feff}') {
        s.drain(..'\u{feff}'.len_utf8());
    }
    Ok(s)
}

/// Parse JSON text; a syntax error is reported like a validation error (code `parse`).
fn parse_json(text: &str) -> Result<Value, Issue> {
    serde_json::from_str(text).map_err(|e| Issue::new("", "parse", format!("invalid JSON: {e}")))
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

fn print_issues(kind: &str, issues: &[Issue]) {
    for e in issues {
        let pointer = if e.pointer.is_empty() {
            "/"
        } else {
            &e.pointer
        };
        eprintln!("{kind:<7} {pointer} [{}] {}", e.code, e.message);
    }
}

fn print_report(r: &Report) {
    print_issues("error", &r.errors);
    print_issues("warning", &r.warnings);
}

/// The JSON type name, as in validation messages.
fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Set the option at `path` (a command-line flag) in the problem, creating the objects on
/// the way. A value on the way that is not an object is an invalid problem.
fn set_option(p: &mut Value, path: &[&str], value: Value) -> Result<(), Issue> {
    let mut cur = p;
    let mut pointer = String::new();
    for (k, key) in path.iter().enumerate() {
        let Value::Object(o) = cur else {
            return Err(Issue::new(
                if pointer.is_empty() { "/" } else { &pointer }.to_string(),
                "type",
                format!(
                    "expected object, got {} (a command-line option sets a field in it)",
                    type_name(cur)
                ),
            ));
        };
        pointer.push('/');
        pointer.push_str(key);
        if k + 1 == path.len() {
            o.insert(key.to_string(), value);
            return Ok(());
        }
        cur = o.entry(key.to_string()).or_insert_with(|| json!({}));
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(Failure::Invalid(errors)) => {
            print_issues("error", &errors);
            ExitCode::from(1)
        }
        Err(Failure::Input(e)) => {
            eprintln!("label-anything: {e}");
            ExitCode::from(1)
        }
        Err(Failure::Other(e)) => {
            eprintln!("label-anything: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, Failure> {
    match cli.cmd {
        Cmd::Place {
            problem,
            output,
            debug_svg,
            time,
            seed,
            strategy,
            degrade,
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
                    let v = parse_json(&text).map_err(|e| Failure::Invalid(vec![e]))?;
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
                    let name = if csv_path == "-" { "stdin" } else { csv_path };
                    let v = csv::problem_from_csv(&read_input(csv_path)?, name, &opts)
                        .map_err(Failure::Input)?;
                    (v, NativeEnv::new())
                }
                (Some(_), Some(_)) => {
                    return Err(Failure::Other(
                        "give either a problem file or --anchors, not both".into(),
                    ))
                }
                (None, None) => {
                    return Err(Failure::Other("missing problem file (or --anchors)".into()))
                }
            };
            let mut options: Vec<(&[&str], Value)> = Vec::new();
            if let Some(t) = time {
                options.push((&["solver", "time_budget_ms"], json!(t)));
            }
            if let Some(s) = seed {
                options.push((&["solver", "seed"], json!(s)));
            }
            if let Some(s) = strategy {
                options.push((&["solver", "strategy"], json!(s)));
            }
            if let Some(d) = degrade {
                options.push((&["degrade"], json!(d)));
            }
            if let Some(o) = omission {
                options.push((&["priority", "omission"], json!(o)));
            }
            if let Some(m) = max_labels {
                options.push((&["priority", "budget", "max_labels"], json!(m)));
            }
            if let Some(ps) = preset {
                options.push((&["preset"], json!(ps)));
            }
            if let Some(fs) = font_size {
                options.push((&["defaults", "font", "size"], json!(fs)));
            }
            if let Some((w, h)) = canvas {
                options.push((&["canvas", "width"], json!(w)));
                options.push((&["canvas", "height"], json!(h)));
            }
            if let Some(bg) = background {
                let ext = bg
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                // relative to the current directory, not to the problem file
                let path = std::path::absolute(&bg)
                    .map_err(|e| format!("{}: {e}", bg.display()))?
                    .to_string_lossy()
                    .into_owned();
                if ext == "svg" {
                    options.push((&["obstacles", "svg"], json!({"path": path})));
                } else {
                    options.push((&["obstacles", "raster"], json!({"source": path})));
                }
            }
            if debug_svg.is_some() {
                options.push((&["output", "debug_svg"], json!(true)));
            }
            let errors: Vec<Issue> = options
                .into_iter()
                .filter_map(|(path, value)| set_option(&mut p, path, value).err())
                .collect();
            if !errors.is_empty() {
                return Err(Failure::Invalid(errors));
            }
            let report = label_anything::validate(&p);
            print_report(&report);
            if !report.valid {
                return Ok(ExitCode::from(1));
            }
            let validation_warnings = report.warnings.clone();
            let clockless = Clockless(&env);
            let env: &dyn Env = if no_clock { &clockless } else { &env };
            for _ in 0..warmup {
                label_anything::place_validated(&p, env, label_anything::validate(&p))
                    .map_err(|e| e.to_string())?;
            }
            let mut result =
                label_anything::place_validated(&p, env, report).map_err(|e| e.to_string())?;
            // warnings found while preparing (the validation warnings are printed already)
            let more: Vec<Issue> = result["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|w| {
                    let s = |k: &str| w[k].as_str().unwrap_or("").to_string();
                    Issue::new(s("pointer"), &s("code"), s("message"))
                })
                .filter(|w| {
                    !validation_warnings.iter().any(|v| {
                        (&v.pointer, &v.code, &v.message) == (&w.pointer, &w.code, &w.message)
                    })
                })
                .collect();
            print_issues("warning", &more);
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
            let p = parse_json(&read_input(&problem)?).map_err(|e| Failure::Invalid(vec![e]))?;
            let report = label_anything::validate(&p);
            print_issues("warning", &report.warnings);
            if !report.valid {
                return Err(Failure::Invalid(report.errors));
            }
            let r: Value = serde_json::from_str(&read_input(&result)?)
                .map_err(|e| Failure::Input(format!("{result}: invalid JSON: {e}")))?;
            check_result(&p, &r).map_err(|e| {
                Failure::Input(format!("{result} is not a result of {problem}: {e}"))
            })?;
            let env = env_for(Some(&problem));
            let svg = label_anything::render_svg(&p, &r, &env);
            let png = Path::new(&output)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("png"));
            if png {
                let png = svg_to_png(&svg)?;
                std::fs::write(&output, png).map_err(|e| format!("{output}: {e}"))?;
                return Ok(ExitCode::SUCCESS);
            }
            write_output(&output, &svg)?;
            Ok(ExitCode::SUCCESS)
        }
        Cmd::Validate { problem, json } => {
            let text = read_input(&problem)?;
            let report = match parse_json(&text) {
                Ok(v) => label_anything::validate(&v),
                Err(e) => Report {
                    valid: false,
                    errors: vec![e],
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
                            return Err(Failure::Other(
                                "bench/run.py not found; pass --repo".into(),
                            ));
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
        Cmd::Serve {
            port,
            host,
            allow_files,
            workers,
        } => serve(&host, port, allow_files, workers),
    }
}

/// Check that a result belongs to a problem: one placement per item, with the item's id,
/// in input order.
fn check_result(problem: &Value, result: &Value) -> Result<(), String> {
    let placements = result["placements"]
        .as_array()
        .ok_or("it has no \"placements\" array")?;
    let items = problem["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if placements.len() != items.len() {
        return Err(format!(
            "{} placements for {} items",
            placements.len(),
            items.len()
        ));
    }
    for (k, (pl, it)) in placements.iter().zip(items).enumerate() {
        let item_id = it["id"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| k.to_string());
        let id = pl["id"].as_str().unwrap_or("");
        if id != item_id {
            return Err(format!("placement {k} is '{id}', item {k} is '{item_id}'"));
        }
    }
    Ok(())
}

fn serve(
    host: &str,
    port: u16,
    allow_files: bool,
    workers: Option<u16>,
) -> Result<ExitCode, Failure> {
    let server =
        tiny_http::Server::http((host, port)).map_err(|e| format!("{host}:{port}: {e}"))?;
    let loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    let files = loopback || allow_files;
    let workers = workers.map(usize::from).unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
    });
    eprintln!(
        "label-anything serving on http://{host}:{port} (POST /place, POST /validate; {workers} workers; file access {})",
        if files { "on" } else { "off; --allow-files turns it on" }
    );
    // every worker takes the next request: a long solve does not hold up the others
    let server = std::sync::Arc::new(server);
    let threads: Vec<_> = (0..workers)
        .map(|_| {
            let server = std::sync::Arc::clone(&server);
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
                    respond(req, files);
                }
            })
        })
        .collect();
    for t in threads {
        let _ = t.join();
    }
    Ok(ExitCode::SUCCESS)
}

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

/// Answers one request of `serve`.
fn respond(mut req: tiny_http::Request, files: bool) {
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let body = body.strip_prefix('\u{feff}').unwrap_or(&body);
    let path = req.url().split('?').next().unwrap_or("");
    let cors = header("Access-Control-Allow-Origin", "*");
    if req.method() == &tiny_http::Method::Options {
        // CORS preflight: browsers send it before a POST with Content-Type: application/json
        let resp = tiny_http::Response::empty(204)
            .with_header(cors)
            .with_header(header("Access-Control-Allow-Methods", "POST, GET, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "Content-Type"))
            .with_header(header("Access-Control-Max-Age", "86400"));
        let _ = req.respond(resp);
        return;
    }
    let (status, text) = match (req.method(), path) {
        // malformed JSON is an invalid problem, as on the command line: 422 here, a
        // `parse` error in the report of /validate
        (tiny_http::Method::Post, "/place") => {
            let mut env = NativeEnv::new();
            env.allow_files = files;
            match label_anything::place_json_with(body, &env) {
                Ok(r) => (200, r),
                Err(e) => (422, format!("{{\"errors\":{e}}}")),
            }
        }
        (tiny_http::Method::Post, "/validate") => (
            200,
            match parse_json(body) {
                Ok(v) => serde_json::to_string(&label_anything::validate(&v)).unwrap_or_default(),
                Err(e) => json!({"valid": false, "errors": [e], "warnings": []}).to_string(),
            },
        ),
        (tiny_http::Method::Get, "/") | (tiny_http::Method::Get, "/health") => (
            200,
            json!({"name": "label-anything", "version": label_anything::VERSION}).to_string(),
        ),
        _ => (404, json!({"error": "not found"}).to_string()),
    };
    let resp = tiny_http::Response::from_string(text)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(cors);
    let _ = req.respond(resp);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_on_wrong_types_are_issues() {
        let mut p = json!({"solver": "fast", "items": []});
        let e = set_option(&mut p, &["solver", "seed"], json!(1)).unwrap_err();
        assert_eq!((e.pointer.as_str(), e.code.as_str()), ("/solver", "type"));
        let mut p = json!([]);
        let e = set_option(&mut p, &["preset"], json!("map")).unwrap_err();
        assert_eq!(e.pointer, "/");
        let mut p = json!({"canvas": {"width": 1, "region": [0, 0, 1, 1]}, "items": []});
        set_option(&mut p, &["canvas", "width"], json!(800)).unwrap();
        set_option(&mut p, &["priority", "budget", "max_labels"], json!(3)).unwrap();
        assert_eq!(p["canvas"], json!({"width": 800, "region": [0, 0, 1, 1]}));
        assert_eq!(p["priority"]["budget"]["max_labels"], 3);
    }

    #[test]
    fn canvas_sizes() {
        assert_eq!(parse_canvas("800x600"), Ok((800.0, 600.0)));
        assert_eq!(parse_canvas("800X600.5"), Ok((800.0, 600.5)));
        assert!(parse_canvas("800x").is_err() && parse_canvas("800,600").is_err());
    }

    #[test]
    fn results_of_other_problems() {
        let p = json!({"items": [{"id": "a"}, {}]});
        let r = |ids: &[&str]| json!({"placements": ids.iter().map(|i| json!({"id": i})).collect::<Vec<_>>()});
        assert!(check_result(&p, &r(&["a", "1"])).is_ok());
        assert_eq!(
            check_result(&p, &r(&["a"])).unwrap_err(),
            "1 placements for 2 items"
        );
        assert_eq!(
            check_result(&p, &r(&["a", "b"])).unwrap_err(),
            "placement 1 is 'b', item 1 is '1'"
        );
        assert!(check_result(&p, &json!({})).is_err());
    }
}
