//! Classification of primitives and geometry lookup for `from_svg` marks.
//! Mirrors `classify.ts`.

use crate::error::SvgError;
use crate::selector::Selector;
use crate::{Geometry, Primitive, Scene};

/// The class name that drops matching primitives.
pub const IGNORE: &str = "ignore";

/// A class rule `{selector, class}` (`class` may be `"ignore"`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassRule {
    /// Selector (our CSS subset, see [`Selector`]).
    pub selector: String,
    /// Obstacle class, or `"ignore"`.
    pub class: String,
}

impl ClassRule {
    /// Convenience constructor.
    pub fn new(selector: impl Into<String>, class: impl Into<String>) -> ClassRule {
        ClassRule {
            selector: selector.into(),
            class: class.into(),
        }
    }
}

/// A drawn primitive with its class.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Classified<'a> {
    /// The class (never `"ignore"`).
    pub class: &'a str,
    /// Index into [`Scene::primitives`].
    pub index: usize,
    /// The primitive.
    pub primitive: &'a Primitive,
}

/// Classifies all primitives: the first rule whose selector matches the primitive's
/// element (the outermost `<use>` for instance geometry) wins, else `default_class`.
/// Primitives of class `"ignore"` are dropped. Errors: selector syntax (`pattern`).
pub fn classify<'a>(
    scene: &'a Scene,
    rules: &'a [ClassRule],
    default_class: &'a str,
) -> Result<Vec<Classified<'a>>, SvgError> {
    let mut selectors = Vec::with_capacity(rules.len());
    for (k, r) in rules.iter().enumerate() {
        let s = Selector::parse(&r.selector).map_err(|e| SvgError {
            code: e.code,
            message: format!("class rule {k}: {}", e.message),
        })?;
        selectors.push(s);
    }
    let ctx = scene.match_context();
    let mut out = Vec::new();
    let mut memo: Option<(usize, &'a str)> = None;
    for (index, p) in scene.primitives.iter().enumerate() {
        let class = match memo {
            Some((el, c)) if el == p.element => c,
            _ => {
                let c = selectors
                    .iter()
                    .position(|s| s.matches_in(&scene.elements, p.element, &ctx))
                    .map_or(default_class, |k| rules[k].class.as_str());
                memo = Some((p.element, c));
                c
            }
        };
        if class != IGNORE {
            out.push(Classified {
                class,
                index,
                primitive: p,
            });
        }
    }
    Ok(out)
}

/// A fill of a region (spec §4.8): a polygon primitive and the rule that made it part of
/// a region.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RegionFill<'a> {
    /// Index of the first selector that matches `element`.
    pub rule: usize,
    /// The element that selector matches: the primitive's element (the outermost `<use>`
    /// for instance geometry) or its nearest ancestor that a selector matches.
    pub element: usize,
    /// Index into [`Scene::primitives`].
    pub index: usize,
    /// The primitive (always a [`Geometry::Polygon`]: fills only).
    pub primitive: &'a Primitive,
}

/// The fills of regions, in paint order: every fill polygon whose element, or else the
/// nearest of its ancestors, matches one of `selectors`, with the first selector matching
/// that element. Strokes and text boxes are never part of a region. Errors: selector
/// syntax (`pattern`, naming the rule).
pub fn regions<'a>(
    scene: &'a Scene,
    selectors: &[String],
) -> Result<Vec<RegionFill<'a>>, SvgError> {
    let mut parsed = Vec::with_capacity(selectors.len());
    for (k, s) in selectors.iter().enumerate() {
        parsed.push(Selector::parse(s).map_err(|e| SvgError {
            code: e.code,
            message: format!("region rule {k}: {}", e.message),
        })?);
    }
    let ctx = scene.match_context();
    // the nearest element (itself or an ancestor) a selector matches, with that selector:
    // parents precede their children in document order
    let mut nearest: Vec<Option<(usize, usize)>> = Vec::with_capacity(scene.elements.len());
    for i in 0..scene.elements.len() {
        let own = parsed
            .iter()
            .position(|s| s.matches_in(&scene.elements, i, &ctx))
            .map(|k| (i, k));
        let inherited = scene.elements[i].parent.and_then(|p| nearest[p]);
        nearest.push(own.or(inherited));
    }
    let mut out = Vec::new();
    for (index, p) in scene.primitives.iter().enumerate() {
        if !matches!(p.geometry, Geometry::Polygon { .. }) {
            continue;
        }
        if let Some((element, rule)) = nearest[p.element] {
            out.push(RegionFill {
                rule,
                element,
                index,
                primitive: p,
            });
        }
    }
    Ok(out)
}

/// The primitives of the element with this `id` and its descendants (`None` if there is
/// no such element).
pub fn element_geometry<'a>(scene: &'a Scene, id: &str) -> Option<&'a [Primitive]> {
    scene.element_by_id(id).map(|i| scene.subtree_primitives(i))
}

/// The primitives of all elements matching `selector` (and their descendants), each once,
/// in paint order. Errors: selector syntax (`pattern`).
pub fn select<'a>(scene: &'a Scene, selector: &str) -> Result<Vec<&'a Primitive>, SvgError> {
    let sel = Selector::parse(selector)?;
    let ctx = scene.match_context();
    let mut out = Vec::new();
    let mut covered = 0usize;
    for i in 0..scene.elements.len() {
        if i < covered {
            continue;
        }
        if sel.matches_in(&scene.elements, i, &ctx) {
            out.extend(scene.subtree_primitives(i));
            covered = scene.elements[i].subtree_end;
        }
    }
    Ok(out)
}

/// The outline of some primitives (e.g. from [`element_geometry`] or [`select`]) for use as
/// an item mark: per drawn shape, its fill polygon if it has one, else its text boxes as
/// polygons, else its stroke polylines (to be treated as capsules).
pub fn outline<'a>(primitives: impl IntoIterator<Item = &'a Primitive>) -> Vec<Geometry> {
    let mut out = Vec::new();
    let mut group: Vec<&Primitive> = Vec::new();
    for p in primitives {
        if group.last().is_some_and(|g| g.shape != p.shape) {
            flush(&mut group, &mut out);
        }
        group.push(p);
    }
    flush(&mut group, &mut out);
    out
}

fn flush(group: &mut Vec<&Primitive>, out: &mut Vec<Geometry>) {
    let has_fill = group
        .iter()
        .any(|p| matches!(p.geometry, Geometry::Polygon { .. }));
    let has_rect = group
        .iter()
        .any(|p| matches!(p.geometry, Geometry::Rect { .. }));
    for p in group.iter() {
        match &p.geometry {
            Geometry::Polygon { .. } => out.push(p.geometry.clone()),
            Geometry::Rect { x, y, w, h } => out.push(Geometry::Polygon {
                rings: vec![vec![[*x, *y], [x + w, *y], [x + w, y + h], [*x, y + h]]],
                even_odd: false,
            }),
            Geometry::Polyline { .. } => {
                if !has_fill && !has_rect {
                    out.push(p.geometry.clone());
                }
            }
        }
    }
    group.clear();
}
