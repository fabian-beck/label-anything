//! The environment of a solve: pluggable backends and host callbacks (spec §6.4).
//!
//! The core has no I/O. File access, the clock and host callbacks are injected through
//! [`Env`]. SVG backgrounds use `label-anything-svg` by default ([`BuiltinSvg`]; a host
//! may supply another [`SvgBackend`]); raster pixel modes come from
//! `label-anything-raster` (image decoding with the `decode` feature). The
//! `label-anything` facade crate provides a complete environment; tests use [`BasicEnv`].

use crate::geom::{Rect, P};

/// Font selection passed to a host `measure` callback.
#[derive(Clone, Debug, PartialEq)]
pub struct FontSpec {
    pub family: String,
    pub weight: u16,
    pub italic: bool,
    pub size: f64,
}

/// Host-measured text metrics (px). `ascent`/`descent` are positive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextMetrics {
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
}

/// Geometry produced by an SVG backend, in canvas pixels.
#[derive(Clone, Debug, PartialEq)]
pub enum Geom {
    Polygon {
        rings: Vec<Vec<P>>,
        even_odd: bool,
    },
    Polyline {
        points: Vec<P>,
        width: f64,
        closed: bool,
    },
    Rect(Rect),
}

/// A parsed SVG document.
pub trait SvgDoc {
    /// Viewport size in px (before mapping to the canvas).
    fn size(&self) -> (f64, f64);
    /// Classify drawn geometry by the first matching `(selector, class)` rule; class
    /// `"ignore"` drops geometry. Elements whose id is in `exclude_ids` are skipped.
    /// Selector errors return `(rule index, message)`.
    fn classify(
        &self,
        rules: &[(String, String)],
        default_class: &str,
        exclude_ids: &[String],
    ) -> Result<Vec<(String, Geom)>, (usize, String)>;
    /// Geometry of the element with this id (and its descendants).
    fn geometry_by_id(&self, id: &str) -> Option<Vec<Geom>>;
    /// Geometry of all elements matching `selector`.
    fn geometry_by_selector(&self, selector: &str) -> Result<Vec<Geom>, String>;
}

/// Parses SVG markup into an [`SvgDoc`] mapped onto the canvas.
pub trait SvgBackend {
    /// `canvas`: target canvas size (the viewport is scaled onto it), or `None` to keep
    /// SVG user units. `measure(text, font_size_px, family, weight)` gives text widths.
    fn load(
        &self,
        markup: &str,
        canvas: Option<(f64, f64)>,
        tolerance: f64,
        measure: &dyn Fn(&str, f64, &str, u16) -> f64,
    ) -> Result<Box<dyn SvgDoc>, String>;
}

/// Raster processing mode with its parameters (spec §4.6).
pub use la_raster::Mode as RasterMode;
/// RGBA8 image, row-major, straight alpha (from `label-anything-raster`).
pub use la_raster::Rgba as RgbaImage;

/// Resolved options of one raster source.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterOpts {
    pub mode: RasterMode,
    pub class: String,
    pub scale: f64,
    pub offset: P,
}

/// The built-in SVG backend (`label-anything-svg`, identical to `@label-anything/svg`).
pub struct BuiltinSvg;

/// The instance [`Env::svg`] returns by default.
pub static BUILTIN_SVG: BuiltinSvg = BuiltinSvg;

struct BuiltinDoc {
    scene: la_svg::Scene,
}

fn geom_of(g: &la_svg::Geometry) -> Geom {
    let pt = |p: &la_svg::Point| P::new(p[0], p[1]);
    match g {
        la_svg::Geometry::Polygon { rings, even_odd } => Geom::Polygon {
            rings: rings.iter().map(|r| r.iter().map(pt).collect()).collect(),
            even_odd: *even_odd,
        },
        la_svg::Geometry::Polyline {
            points,
            width,
            closed,
        } => Geom::Polyline {
            points: points.iter().map(pt).collect(),
            width: *width,
            closed: *closed,
        },
        la_svg::Geometry::Rect { x, y, w, h } => Geom::Rect(Rect::new(*x, *y, x + w, y + h)),
    }
}

impl SvgDoc for BuiltinDoc {
    fn size(&self) -> (f64, f64) {
        (self.scene.canvas_width, self.scene.canvas_height)
    }
    fn classify(
        &self,
        rules: &[(String, String)],
        default_class: &str,
        exclude_ids: &[String],
    ) -> Result<Vec<(String, Geom)>, (usize, String)> {
        // report the first rule whose selector does not parse
        for (i, (sel, _)) in rules.iter().enumerate() {
            if let Err(e) = la_svg::Selector::parse(sel) {
                return Err((i, e.message));
            }
        }
        let rules: Vec<la_svg::ClassRule> = rules
            .iter()
            .map(|(s, c)| la_svg::ClassRule::new(s.clone(), c.clone()))
            .collect();
        // excluded elements and their descendants (instance geometry belongs to the
        // outermost <use>)
        let excluded: Vec<(usize, usize)> = exclude_ids
            .iter()
            .filter_map(|id| self.scene.element_by_id(id))
            .map(|e| (e, self.scene.elements[e].subtree_end))
            .collect();
        let out =
            la_svg::classify(&self.scene, &rules, default_class).map_err(|e| (0, e.message))?;
        Ok(out
            .into_iter()
            .filter(|c| {
                !excluded
                    .iter()
                    .any(|&(a, b)| c.primitive.element >= a && c.primitive.element < b)
            })
            .map(|c| (c.class.to_string(), geom_of(&c.primitive.geometry)))
            .collect())
    }
    fn geometry_by_id(&self, id: &str) -> Option<Vec<Geom>> {
        la_svg::element_geometry(&self.scene, id)
            .map(|ps| ps.iter().map(|p| geom_of(&p.geometry)).collect())
    }
    fn geometry_by_selector(&self, selector: &str) -> Result<Vec<Geom>, String> {
        la_svg::select(&self.scene, selector)
            .map(|ps| ps.into_iter().map(|p| geom_of(&p.geometry)).collect())
            .map_err(|e| e.message)
    }
}

impl SvgBackend for BuiltinSvg {
    fn load(
        &self,
        markup: &str,
        canvas: Option<(f64, f64)>,
        tolerance: f64,
        measure: &dyn Fn(&str, f64, &str, u16) -> f64,
    ) -> Result<Box<dyn SvgDoc>, String> {
        let opts = la_svg::ParseOptions {
            canvas,
            tolerance,
            measure: Some(measure),
            ..Default::default()
        };
        let scene = la_svg::parse(markup, &opts)
            .map_err(|e| format!("{} ({})", e.message, e.code.as_str()))?;
        Ok(Box::new(BuiltinDoc { scene }))
    }
}

/// Everything the core needs from its host.
pub trait Env {
    /// The SVG backend ([`BUILTIN_SVG`] unless the host supplies its own).
    fn svg(&self) -> Option<&dyn SvgBackend> {
        Some(&BUILTIN_SVG)
    }
    /// A raster background supplied directly by the host (C ABI / bindings): replaces the
    /// image of the first `obstacles.raster` source (or adds one with default options).
    fn raster_override(&self) -> Option<RgbaImage> {
        None
    }
    /// Read a file (CLI, Python, Java, Node). Unavailable by default.
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        Err(format!(
            "file access is not available in this environment ({path})"
        ))
    }
    /// Monotonic time in milliseconds (only used for the wall-clock guard and stats).
    fn now_ms(&self) -> f64 {
        0.0
    }
    /// Host text measurement (overrides the built-in shaper when it returns `Some`).
    fn measure(&self, _text: &str, _font: &FontSpec) -> Option<TextMetrics> {
        None
    }
    /// Host priority callback: `(tier, score)` per item, evaluated once per item.
    fn priority(&self, _item: &serde_json::Value, _index: usize) -> Option<(Option<i64>, f64)> {
        None
    }
    /// Whether a host priority callback is installed.
    fn has_priority_callback(&self) -> bool {
        false
    }
    /// Extra user cost of a candidate (item id, box, has leader).
    fn extra_cost(&self, _item_id: &str, _bbox: &Rect, _leader: bool) -> f64 {
        0.0
    }
    fn has_cost_callback(&self) -> bool {
        false
    }
    /// Progress notification.
    fn progress(&self, _phase: &str, _fraction: f64) {}
    /// Cancellation request.
    fn cancelled(&self) -> bool {
        false
    }
}

/// An environment without backends (vector obstacles only).
#[derive(Default)]
pub struct BasicEnv;

impl Env for BasicEnv {}
