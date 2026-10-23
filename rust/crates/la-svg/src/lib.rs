//! # label-anything-svg
//!
//! SVG backgrounds → classified obstacle geometry for the Label Anything label placement
//! engine (spec §4.5). The TypeScript package `@label-anything/svg` implements the same
//! algorithms line by line; both are tested against `conformance/svg/`.
//!
//! ```
//! use label_anything_svg::{classify, parse, ClassRule, Geometry, ParseOptions};
//!
//! let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
//!   <rect width="200" height="100" fill="white"/>
//!   <circle id="p1" cx="50" cy="50" r="4" fill="steelblue"/>
//!   <text x="100" y="50" font-size="10">Label</text>
//! </svg>"#;
//! let scene = parse(svg, &ParseOptions::default()).unwrap();
//! let rules = vec![
//!     ClassRule::new(":background", "ignore"),
//!     ClassRule::new("text", "text"),
//!     ClassRule::new("circle", "points"),
//! ];
//! let classified = classify(&scene, &rules, "ink").unwrap();
//! assert_eq!(classified.len(), 2);
//! assert_eq!(classified[0].class, "points");
//! assert!(matches!(classified[1].primitive.geometry, Geometry::Rect { .. }));
//! ```
//!
//! ## Model
//!
//! * [`parse`] reads the markup with our own small XML parser (no recursion per nesting
//!   level), resolves styles (presentation attributes, `<style>` sheets, inline styles,
//!   inheritance), and renders the document into [`Primitive`]s in **canvas pixels**
//!   (y down): fills become [`Geometry::Polygon`]s, strokes [`Geometry::Polyline`]s
//!   (capsules of the transformed stroke width), text elements [`Geometry::Rect`]s.
//! * Geometry drawn through `<use>` is attributed to the **outermost** `<use>` element
//!   ([`Primitive::element`]); [`Primitive::source`] names the element that defines it.
//!   Primitives are ordered by paint order, which is also non-decreasing in `element`, so
//!   the primitives of an element subtree form a contiguous slice.
//! * [`classify`] assigns classes with the first matching [`ClassRule`];
//!   [`element_geometry`], [`select`] and [`outline`] serve `from_svg` item marks;
//!   [`regions`] finds the fills of the picture's regions (spec §4.8) as [`RegionFill`]s.
//!
//! Not modelled (documented in spec §4.5): clipping, masks, filters, markers, dashes,
//! patterns/gradients (any valid paint server counts as opaque), `textLength`, per-glyph
//! positioning (only the first value of `x`/`y`/`dx`/`dy` is used), `textPath` layout.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::BTreeMap;
use std::fmt;

mod classify;
mod color;
mod css;
mod error;
mod flatten;
mod geom;
mod num;
mod path;
mod render;
mod selector;
mod style;
mod text;
mod transform;
#[cfg(test)]
mod unit_tests;
mod xml;

pub use classify::{
    classify, element_geometry, outline, regions, select, ClassRule, Classified, RegionFill, IGNORE,
};
pub use error::{SvgError, SvgErrorCode};
pub use render::parse;
pub use selector::{Selector, BACKGROUND_FRACTION, SMALL_PX};

/// A point `[x, y]` in canvas pixels.
pub type Point = [f64; 2];

/// Text measurement callback: `(text, font_size_px, family, weight) -> width_px`.
///
/// `font_size_px` is the font size in the text element's user units, `family` the first
/// family of the computed `font-family` list (unquoted), `weight` the numeric weight.
pub type MeasureFn<'a> = &'a dyn Fn(&str, f64, &str, u16) -> f64;

/// Default curve flattening tolerance (px).
pub const DEFAULT_TOLERANCE: f64 = 0.25;
/// Default ascent of text boxes (em).
pub const DEFAULT_ASCENT: f64 = 0.8;
/// Default descent of text boxes (em).
pub const DEFAULT_DESCENT: f64 = 0.2;
/// Width per code point of the default text measurement (em).
pub const DEFAULT_ADVANCE: f64 = 0.55;

/// Options of [`parse`].
#[derive(Clone, Copy)]
pub struct ParseOptions<'a> {
    /// Target canvas size `(width, height)`; the SVG viewport is scaled onto it
    /// (non-uniformly if the aspect ratios differ). `None`: the viewport size.
    pub canvas: Option<(f64, f64)>,
    /// Curve flattening tolerance in canvas pixels (> 0).
    pub tolerance: f64,
    /// Text measurement; `None`: [`DEFAULT_ADVANCE`] em per code point.
    pub measure: Option<MeasureFn<'a>>,
    /// Ascent of text boxes in em.
    pub ascent: f64,
    /// Descent of text boxes in em.
    pub descent: f64,
}

impl Default for ParseOptions<'_> {
    fn default() -> Self {
        ParseOptions {
            canvas: None,
            tolerance: DEFAULT_TOLERANCE,
            measure: None,
            ascent: DEFAULT_ASCENT,
            descent: DEFAULT_DESCENT,
        }
    }
}

impl fmt::Debug for ParseOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ParseOptions")
            .field("canvas", &self.canvas)
            .field("tolerance", &self.tolerance)
            .field("measure", &self.measure.map(|_| "<fn>"))
            .field("ascent", &self.ascent)
            .field("descent", &self.descent)
            .finish()
    }
}

/// An axis-aligned rectangle in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Rect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width (≥ 0).
    pub w: f64,
    /// Height (≥ 0).
    pub h: f64,
}

/// Drawn geometry in canvas pixels.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "lowercase"))]
pub enum Geometry {
    /// A filled area: implicitly closed rings (each ≥ 3 points) combined with the fill rule.
    Polygon {
        /// Rings (one per subpath).
        rings: Vec<Vec<Point>>,
        /// `fill-rule: evenodd` (else non-zero).
        even_odd: bool,
    },
    /// A stroked subpath, to be treated as a capsule chain (round joins and caps).
    Polyline {
        /// ≥ 2 points; closed polylines do not repeat the first point.
        points: Vec<Point>,
        /// Stroke width in canvas pixels.
        width: f64,
        /// Whether the subpath is closed.
        closed: bool,
    },
    /// The bounding box of a text chunk.
    Rect {
        /// Left.
        x: f64,
        /// Top.
        y: f64,
        /// Width.
        w: f64,
        /// Height.
        h: f64,
    },
}

/// One piece of drawn geometry.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Primitive {
    /// The element it is attributed to (the outermost `<use>` for instance content).
    pub element: usize,
    /// The element whose geometry it is (e.g. the `<path>` inside `<defs>`).
    pub source: usize,
    /// Drawn-shape counter: the fill and stroke primitives of one shape share it.
    pub shape: usize,
    /// The geometry.
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub geometry: Geometry,
}

/// One XML element of the document, in document order.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Element {
    /// Local name (`rect`, `linearGradient`, ...).
    pub tag: String,
    /// Namespace URI for elements outside the SVG namespace (never drawn); `None` for SVG
    /// elements (and elements without a namespace, which are treated as SVG).
    pub namespace: Option<String>,
    /// The `id` attribute.
    pub id: Option<String>,
    /// Whitespace-separated tokens of the `class` attribute.
    pub classes: Vec<String>,
    /// Attributes in source order, keyed by their qualified name as written
    /// (`xlink:href`); namespace declarations are not included.
    #[cfg_attr(feature = "serde", serde(serialize_with = "serialize_attributes"))]
    pub attributes: Vec<(String, String)>,
    /// Parent element.
    pub parent: Option<usize>,
    /// End (exclusive) of this element's descendants: they are `index + 1 .. subtree_end`.
    pub subtree_end: usize,
    /// Rendered directly (not only through `<use>`), visible and with non-zero opacity.
    pub drawn: bool,
    /// Computed fill paint ≠ none with alpha × `fill-opacity` > 0 (images: always;
    /// `<line>`: never).
    pub filled: bool,
    /// Computed stroke paint ≠ none with alpha × `stroke-opacity` > 0 and width > 0.
    pub stroked: bool,
    /// Geometry bounding box (without stroke width) of the element and its rendered
    /// descendants (for `<use>`: its instance), in canvas pixels; `None` if it is not
    /// rendered or has no geometry. Ignores `visibility`, paint and opacity (like getBBox).
    pub bbox: Option<Rect>,
}

impl Element {
    /// The value of the attribute with this qualified name.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[cfg(feature = "serde")]
fn serialize_attributes<S: serde::Serializer>(
    attrs: &[(String, String)],
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut m = s.serialize_map(Some(attrs.len()))?;
    for (k, v) in attrs {
        m.serialize_entry(k, v)?;
    }
    m.end()
}

/// A parsed and rendered SVG document.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Scene {
    /// Viewport width of the SVG in px (resolved `width`).
    pub width: f64,
    /// Viewport height of the SVG in px (resolved `height`).
    pub height: f64,
    /// Canvas width (the target size, or the viewport width).
    pub canvas_width: f64,
    /// Canvas height.
    pub canvas_height: f64,
    /// The root `viewBox` `[min_x, min_y, width, height]`, if valid.
    pub view_box: Option<[f64; 4]>,
    /// All elements in document order (index 0 is the root `<svg>`).
    pub elements: Vec<Element>,
    /// Drawn geometry in paint order.
    pub primitives: Vec<Primitive>,
    /// Non-fatal problems (codes `ignored`, `limit`).
    pub warnings: Vec<SvgError>,
    #[cfg_attr(feature = "serde", serde(skip))]
    ids: BTreeMap<String, usize>,
}

impl Scene {
    /// The first element (in document order) with this `id`.
    pub fn element_by_id(&self, id: &str) -> Option<usize> {
        self.ids.get(id).copied()
    }

    /// The primitives attributed to `element` or its descendants (a contiguous slice).
    pub fn subtree_primitives(&self, element: usize) -> &[Primitive] {
        let Some(el) = self.elements.get(element) else {
            return &[];
        };
        let lo = self.primitives.partition_point(|p| p.element < element);
        let hi = self
            .primitives
            .partition_point(|p| p.element < el.subtree_end);
        &self.primitives[lo..hi]
    }

    /// Whether `element` matches `selector`.
    pub fn matches(&self, element: usize, selector: &Selector) -> bool {
        element < self.elements.len()
            && selector.matches_in(&self.elements, element, &self.match_context())
    }

    /// The elements matching `selector`, in document order.
    pub fn select_elements(&self, selector: &Selector) -> Vec<usize> {
        let ctx = self.match_context();
        (0..self.elements.len())
            .filter(|&i| selector.matches_in(&self.elements, i, &ctx))
            .collect()
    }

    pub(crate) fn match_context(&self) -> selector::MatchContext {
        selector::MatchContext {
            canvas_width: self.canvas_width,
            canvas_height: self.canvas_height,
        }
    }
}
