//! The environment of a solve: pluggable backends and host callbacks (spec §6.4).
//!
//! The core has no I/O. SVG parsing, image decoding, file access, the clock and host
//! callbacks are injected through [`Env`]. The `label-anything` facade crate provides a
//! complete environment; tests use [`BasicEnv`].

use crate::geom::{Rect, P};
use crate::grid::GridSpec;

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

/// RGBA8 image, row-major, straight alpha.
#[derive(Clone, Debug)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Raster processing mode with its parameters (spec §4.6).
#[derive(Clone, Debug, PartialEq)]
pub enum RasterMode {
    Ink {
        background: Option<[u8; 3]>,
        threshold: f64,
        dilate: u32,
    },
    Alpha {
        threshold: f64,
    },
    Cost {
        invert: bool,
    },
    ClassMap {
        palette: Vec<([u8; 3], String)>,
        tolerance: f64,
        unmatched_ink: bool,
        background: Option<[u8; 3]>,
        ink_threshold: f64,
    },
    Saliency,
}

/// Resolved options of one raster source.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterOpts {
    pub mode: RasterMode,
    pub class: String,
    pub scale: f64,
    pub offset: P,
}

/// Decodes images and computes per-class grid coverage.
pub trait RasterBackend {
    /// Decode a data URL or bare base64 string.
    fn decode_source(&self, source: &str) -> Result<RgbaImage, String>;
    /// Decode encoded image bytes (PNG, JPEG, WebP).
    fn decode_bytes(&self, bytes: &[u8]) -> Result<RgbaImage, String>;
    /// Coverage (0..255 per cell) of each produced class on `grid`.
    fn coverage(
        &self,
        img: &RgbaImage,
        opts: &RasterOpts,
        grid: &GridSpec,
    ) -> Vec<(String, Vec<u8>)>;
}

/// Everything the core needs from its host.
pub trait Env {
    fn svg(&self) -> Option<&dyn SvgBackend> {
        None
    }
    fn raster(&self) -> Option<&dyn RasterBackend> {
        None
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
