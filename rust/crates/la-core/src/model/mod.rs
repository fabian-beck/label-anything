//! The resolved model: a validated problem with presets, defaults, units and coordinates
//! applied, backgrounds loaded and item geometry built.

pub mod opts;

use crate::env::{Env, FontSpec, Geom, RasterMode, RasterOpts, RgbaImage, SvgDoc};
use crate::geom::path;
use crate::geom::shape::Shape;
use crate::geom::{polygon, Affine, Rect, P};
use crate::options::{lookup, source_opt, Opts};
use crate::units::Length;
use crate::validate::Issue;
use opts::*;
use serde_json::Value;
use std::collections::BTreeMap;

/// Shape of a fixed-size label (icon, box), relative to its box.
#[derive(Clone, Debug, PartialEq)]
pub enum LabelShape {
    Rect,
    Rounded(f64),
    Circle,
    /// Polygon relative to the box's top-left corner.
    Polygon(Vec<P>),
}

impl LabelShape {
    pub fn parse(s: Option<&str>, polygon: Option<&Value>) -> LabelShape {
        match s {
            Some("circle") => LabelShape::Circle,
            Some("polygon") => LabelShape::Polygon(points_of(polygon.unwrap_or(&Value::Null))),
            Some(x) if x.starts_with("rounded:") => {
                LabelShape::Rounded(x[8..].parse().unwrap_or(0.0))
            }
            _ => LabelShape::Rect,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Truncate {
    None,
    End,
    Middle,
}

impl Truncate {
    fn parse(s: &str) -> Truncate {
        match s {
            "end" => Truncate::End,
            "middle" => Truncate::Middle,
            _ => Truncate::None,
        }
    }
}

/// Resolved font of a label.
#[derive(Clone, Debug, PartialEq)]
pub struct FontSel {
    pub family: String,
    pub weight: u16,
    pub italic: bool,
    pub size: f64,
    pub line_height: f64,
    /// Font file (data URL or path) to register for this family/weight/style.
    pub file: Option<String>,
}

impl FontSel {
    pub fn spec(&self, scale: f64) -> FontSpec {
        FontSpec {
            family: self.family.clone(),
            weight: self.weight,
            italic: self.italic,
            size: self.size * scale,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WrapSpec {
    pub max_width: Option<f64>,
    pub max_lines: usize,
    pub balance: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextSpec {
    pub text: String,
    pub alternatives: Vec<String>,
    pub wrap: Option<WrapSpec>,
    pub truncate: Truncate,
    /// Host-measured `(width, height, lines)`.
    pub explicit: Option<(f64, f64, Vec<String>)>,
    pub align: String,
    pub font: FontSel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixedKind {
    Icon,
    Box,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PartSpec {
    Text(TextSpec),
    Fixed {
        kind: FixedKind,
        w: f64,
        h: f64,
        shape: LabelShape,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum LabelSpec {
    Text(TextSpec),
    Fixed {
        kind: FixedKind,
        w: f64,
        h: f64,
        shape: LabelShape,
    },
    Composite {
        row: bool,
        gap: f64,
        align: String,
        parts: Vec<PartSpec>,
    },
}

impl LabelSpec {
    /// The label's main text (for expressions and debug output).
    pub fn text(&self) -> String {
        match self {
            LabelSpec::Text(t) => t.text.clone(),
            LabelSpec::Fixed { .. } => String::new(),
            LabelSpec::Composite { parts, .. } => parts
                .iter()
                .filter_map(|p| match p {
                    PartSpec::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

/// An area anchor's polygon.
#[derive(Clone, Debug)]
pub struct Area {
    pub shape: Shape,
    pub pole: P,
    pub pole_dist: f64,
}

/// Per-item resolved lengths (px).
#[derive(Clone, Debug)]
pub struct ItemLengths {
    pub padding: f64,
    pub buffer: f64,
    pub offset: f64,
    pub inner_padding: f64,
    pub max_distance: f64,
    pub min_distance: f64,
    pub leader_min: f64,
    pub leader_max: f64,
    pub anchor_gap: f64,
    pub clearance: f64,
    pub boundary_gap: f64,
    pub boundary_margin: f64,
}

/// `keep_with` membership.
#[derive(Clone, Debug, PartialEq)]
pub enum KeepWith {
    Set(String),
    Ids(Vec<String>),
}

/// A resolved item.
#[derive(Clone, Debug)]
pub struct Item {
    pub index: usize,
    pub id: String,
    /// Reference point in canvas px.
    pub anchor: P,
    /// The labeled mark (for area anchors: the fallback dot at the pole).
    pub shape: Shape,
    pub area: Option<Area>,
    /// Leaders attach at the tip (icon marks).
    pub tip: bool,
    pub label: LabelSpec,
    pub font: FontSel,
    pub len: ItemLengths,
    pub models: Models,
    pub internal: InternalPolicy,
    pub positions: Vec<Pos>,
    pub attrs: Value,
    pub explicit_priority: Option<f64>,
    pub explicit_tier: Option<i64>,
    pub required: bool,
    pub group: Option<String>,
    pub keep_with: Option<KeepWith>,
    pub svg_id: Option<String>,
    /// The original item JSON (for callbacks).
    pub raw: Value,
}

impl Item {
    pub fn em(&self) -> f64 {
        self.font.size
    }
}

/// A vector obstacle primitive in canvas px.
#[derive(Clone, Debug)]
pub enum Prim {
    Disc {
        c: P,
        r: f64,
    },
    Rect(Rect),
    Polygon {
        rings: Vec<Vec<P>>,
        even_odd: bool,
        bbox: Rect,
    },
    Polyline {
        points: Vec<P>,
        hw: f64,
        closed: bool,
    },
    Shape(Shape),
}

impl Prim {
    pub fn bbox(&self) -> Rect {
        match self {
            Prim::Disc { c, r } => Rect::from_center(*c, *r, *r),
            Prim::Rect(r) => *r,
            Prim::Polygon { bbox, .. } => *bbox,
            Prim::Polyline { points, hw, .. } => crate::geom::bbox_of(points).inflate(*hw),
            Prim::Shape(s) => s.bbox(),
        }
    }
}

/// A decoded raster source with its options.
pub struct RasterSrc {
    pub img: RgbaImage,
    pub opts: RasterOpts,
}

/// The resolved problem.
pub struct Model {
    pub canvas: Option<Rect>,
    /// Labels must stay inside (canvas or region minus padding); `None` = unbounded.
    pub label_area: Option<Rect>,
    /// Leaders must stay inside (the canvas); `None` = unbounded.
    pub leader_area: Option<Rect>,
    /// Extent of the grid.
    pub extent: Rect,
    pub to_px: Affine,
    pub items: Vec<Item>,
    /// Vector obstacles by class (problem vector layers and SVG geometry).
    pub vector: Vec<(String, Prim)>,
    pub rasters: Vec<RasterSrc>,
    pub avoid_label: serde_json::Map<String, Value>,
    pub avoid_leader: serde_json::Map<String, Value>,
    pub avoid_buffer: serde_json::Map<String, Value>,
    pub relaxable: Vec<String>,
    pub placement: PlacementOpts,
    pub leaders: LeaderOpts,
    pub weights: Weights,
    pub solver: SolverOpts,
    pub ladder: Vec<Step>,
    pub degrade: DegradeOpts,
    pub output: OutputOpts,
    pub omission: Omission,
    pub ties: Ties,
    pub band: f64,
    pub max_labels: Option<usize>,
    pub max_ink_fraction: Option<f64>,
    pub focus: Option<P>,
    pub priority_value: Value,
    /// `auto` preset: (crowded fraction, models when crowded) unless the user set models.
    pub auto_crowded: Option<(f64, Models)>,
    pub grid_cell: Option<f64>,
    pub default_em: f64,
    pub shaping: String,
    pub warm: BTreeMap<String, Option<Rect>>,
    pub warnings: Vec<Issue>,
    pub preset_name: String,
    /// Groups of items sharing one label: (representative, members incl. the representative).
    pub groups: Vec<(usize, Vec<usize>)>,
    /// For each item: the representative of its group (itself for representatives).
    pub group_of: Vec<Option<usize>>,
}

impl Model {
    /// Members of the group represented by `rep` (empty if `rep` is not a representative).
    pub fn group_members(&self, rep: usize) -> &[usize] {
        self.groups
            .iter()
            .find(|g| g.0 == rep)
            .map(|g| g.1.as_slice())
            .unwrap_or(&[])
    }
}

/// A model-building failure (the problem passed validation but cannot be solved).
#[derive(Clone, Debug)]
pub struct BuildError {
    pub pointer: String,
    pub code: String,
    pub message: String,
}

fn err(pointer: impl Into<String>, code: &str, message: impl Into<String>) -> BuildError {
    BuildError {
        pointer: pointer.into(),
        code: code.to_string(),
        message: message.into(),
    }
}

pub fn points_of(v: &Value) -> Vec<P> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|q| Some(P::new(q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn weight_of(v: &Value) -> Option<u16> {
    match v {
        Value::Number(n) => n.as_f64().map(|w| w.clamp(1.0, 1000.0) as u16),
        Value::String(s) if s == "bold" => Some(700),
        Value::String(s) if s == "normal" => Some(400),
        _ => None,
    }
}

/// Merge a font object over a base font.
fn font_over(base: &FontSel, v: Option<&Value>) -> FontSel {
    let mut f = base.clone();
    if let Some(Value::Object(o)) = v {
        if let Some(s) = o.get("family").and_then(|x| x.as_str()) {
            f.family = s.to_string();
        }
        if let Some(s) = o.get("size").and_then(|x| x.as_f64()) {
            f.size = s;
        }
        if let Some(w) = o.get("weight").and_then(weight_of) {
            f.weight = w;
        }
        if let Some(s) = o.get("style").and_then(|x| x.as_str()) {
            f.italic = s == "italic";
        }
        if let Some(s) = o.get("line_height").and_then(|x| x.as_f64()) {
            f.line_height = s;
        }
        match o.get("file") {
            Some(Value::String(s)) => f.file = Some(s.clone()),
            Some(Value::Null) => f.file = None,
            _ => {}
        }
    }
    f
}

fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(o @ Value::Object(_)) => vec![o],
        _ => vec![],
    }
}

/// Decode `data:` URLs (base64) into bytes.
pub fn data_url_bytes(s: &str) -> Option<Vec<u8>> {
    let rest = s.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let (meta, data) = (&rest[..comma], &rest[comma + 1..]);
    if meta.ends_with(";base64") {
        base64_decode(data)
    } else {
        Some(percent_decode(data))
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Minimal base64 decoder (standard and URL-safe alphabets, whitespace ignored).
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Build the model. `problem` must have passed `validate`.
pub fn build(problem: &Value, env: &dyn Env) -> Result<Model, BuildError> {
    let mut m = build_raw(problem, env)?;
    resolve_groups(&mut m);
    Ok(m)
}

/// Merge items sharing a `group` id into one label (spec §5.7 "groups"): the first member
/// (input order) represents the group; its mark becomes the convex hull of all member
/// marks, its anchor their centroid, and its text lists the distinct member texts.
fn resolve_groups(m: &mut Model) {
    let n = m.items.len();
    m.group_of = vec![None; n];
    let mut by_name: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for it in &m.items {
        if let Some(g) = &it.group {
            by_name.entry(g.clone()).or_default().push(it.index);
        }
    }
    let mut groups: Vec<(usize, Vec<usize>)> = by_name
        .into_values()
        .filter(|v| v.len() >= 2)
        .map(|v| (v[0], v))
        .collect();
    groups.sort_by_key(|g| g.0);
    for (rep, members) in &groups {
        let mut pts: Vec<P> = Vec::new();
        let mut centroid = P::new(0.0, 0.0);
        for &k in members {
            pts.extend(m.items[k].shape.outline());
            centroid = centroid + m.items[k].anchor;
            m.group_of[k] = Some(*rep);
        }
        centroid = centroid * (1.0 / members.len() as f64);
        let hull = polygon::convex_hull(&pts);
        let shape = if hull.len() >= 3 {
            Shape::polygon(vec![hull], false, centroid)
        } else {
            Shape::circle(centroid, 2.0)
        };
        let texts: Vec<String> = {
            let mut t: Vec<String> = Vec::new();
            for &k in members {
                let s = m.items[k].label.text();
                if !s.is_empty() && !t.contains(&s) {
                    t.push(s);
                }
            }
            t
        };
        let r = &mut m.items[*rep];
        r.anchor = centroid;
        r.shape = shape;
        r.tip = false;
        if let LabelSpec::Text(t) = &mut r.label {
            if texts.len() > 1 && t.explicit.is_none() {
                t.text = texts.join(", ");
                t.alternatives.clear();
            }
        }
    }
    m.groups = groups;
}

fn build_raw(problem: &Value, env: &dyn Env) -> Result<Model, BuildError> {
    let o = Opts::new(problem);
    let mut warnings = Vec::new();
    let default_font = FontSel {
        family: o.string("defaults.font.family"),
        weight: weight_of(&o.get("defaults.font.weight")).unwrap_or(400),
        italic: o.string("defaults.font.style") == "italic",
        size: o.f64("defaults.font.size"),
        line_height: o.f64("defaults.font.line_height"),
        file: o.get("defaults.font.file").as_str().map(str::to_string),
    };
    let default_em = default_font.size;

    // --- rasters (decoded first: they may define the canvas) ---
    let mut rasters = Vec::new();
    let empty_src = Value::Object(Default::default());
    let mut raster_list = as_list(lookup(problem, "obstacles.raster"));
    let mut override_img = env.raster_override();
    if override_img.is_some() && raster_list.is_empty() {
        raster_list.push(&empty_src);
    }
    for (i, src) in raster_list.iter().enumerate() {
        if let Some(img) = override_img.take() {
            let opts = raster_opts(src, "/obstacles/raster")?;
            rasters.push(RasterSrc { img, opts });
            continue;
        }
        let ptr = format!(
            "/obstacles/raster{}",
            if problem
                .pointer("/obstacles/raster")
                .map(|v| v.is_array())
                .unwrap_or(false)
            {
                format!("/{i}")
            } else {
                String::new()
            }
        );
        // decoding errors keep the raster crate's code when it is `unsupported`
        let raster_err = |at: String, e: la_raster::RasterError| {
            let code = if e.kind == la_raster::RasterErrorKind::Unsupported {
                "unsupported"
            } else {
                "invalid_value"
            };
            err(at, code, format!("{} ({})", e.message, e.code()))
        };
        let img = if let Some(rgba) = src.get("rgba") {
            let w = rgba["width"].as_u64().unwrap_or(0) as u32;
            let h = rgba["height"].as_u64().unwrap_or(0) as u32;
            la_raster::rgba_from_base64(w, h, rgba["data"].as_str().unwrap_or(""))
                .map_err(|e| raster_err(format!("{ptr}/rgba/data"), e))?
        } else {
            let s = src["source"].as_str().unwrap_or("");
            if s.starts_with("data:") || looks_base64(s) {
                la_raster::decode_source(s).map_err(|e| raster_err(format!("{ptr}/source"), e))?
            } else {
                let bytes = env
                    .read_file(s)
                    .map_err(|m| err(format!("{ptr}/source"), "invalid_value", m))?;
                la_raster::decode(&bytes).map_err(|e| raster_err(format!("{ptr}/source"), e))?
            }
        };
        let opts = raster_opts(src, &ptr)?;
        rasters.push(RasterSrc { img, opts });
    }

    // --- canvas ---
    let mut canvas: Option<Rect> = problem.get("canvas").map(|c| {
        Rect::new(
            0.0,
            0.0,
            c["width"].as_f64().unwrap_or(0.0),
            c["height"].as_f64().unwrap_or(0.0),
        )
    });
    if canvas.is_none() {
        if let Some(r) = rasters.first() {
            canvas = Some(Rect::new(
                0.0,
                0.0,
                r.img.width as f64 / r.opts.scale,
                r.img.height as f64 / r.opts.scale,
            ));
        }
    }

    // --- SVG documents ---
    let mut svgs: Vec<(Box<dyn SvgDoc>, &Value, String)> = Vec::new();
    let svg_list = as_list(lookup(problem, "obstacles.svg"));
    let svg_is_array = problem
        .pointer("/obstacles/svg")
        .map(|v| v.is_array())
        .unwrap_or(false);
    for (i, src) in svg_list.iter().enumerate() {
        let ptr = format!(
            "/obstacles/svg{}",
            if svg_is_array {
                format!("/{i}")
            } else {
                String::new()
            }
        );
        let Some(backend) = env.svg() else {
            return Err(err(
                ptr,
                "unsupported",
                "SVG backgrounds need an SVG backend (not available in this build)",
            ));
        };
        let markup = match (
            src.get("source").and_then(|s| s.as_str()),
            src.get("path").and_then(|s| s.as_str()),
        ) {
            (Some(s), _) => s.to_string(),
            (None, Some(p)) => {
                let b = env
                    .read_file(p)
                    .map_err(|m| err(format!("{ptr}/path"), "invalid_value", m))?;
                String::from_utf8_lossy(&b).into_owned()
            }
            _ => String::new(),
        };
        let tol = source_opt(src, "obstacles.svg", "tolerance")
            .as_f64()
            .unwrap_or(0.25);
        let measure =
            |t: &str, size: f64, _fam: &str, _w: u16| t.chars().count() as f64 * 0.55 * size;
        let doc = backend
            .load(&markup, canvas.map(|c| (c.w(), c.h())), tol, &measure)
            .map_err(|m| err(format!("{ptr}/source"), "invalid_value", m))?;
        if canvas.is_none() {
            let (w, h) = doc.size();
            canvas = Some(Rect::new(0.0, 0.0, w, h));
        }
        svgs.push((doc, *src, ptr));
    }

    // --- coordinates ---
    let mut to_px = match problem.get("transform").and_then(|t| t.as_array()) {
        Some(t) if t.len() == 6 => {
            let v: Vec<f64> = t.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
            Affine([v[0], v[1], v[2], v[3], v[4], v[5]])
        }
        _ => Affine::IDENTITY,
    };
    if o.string("y_axis") == "up" {
        let h = canvas.map(|c| c.h()).unwrap_or(0.0);
        to_px = to_px.then(&Affine([1.0, 0.0, 0.0, -1.0, 0.0, h]));
    }

    // --- items ---
    let items_json = problem
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let global_models = Models::from_names(&o.strings("placement.models"));
    let user_set_models = lookup(problem, "placement.models").is_some();
    let mut items = Vec::with_capacity(items_json.len());
    let mut used_svg_ids: Vec<String> = Vec::new();
    let auto_marks = svg_list.iter().any(|s| {
        source_opt(s, "obstacles.svg", "auto_mark_items")
            .as_bool()
            .unwrap_or(false)
    });
    for (i, it) in items_json.iter().enumerate() {
        let ptr = format!("/items/{i}");
        let item = build_item(
            i,
            it,
            &ptr,
            &o,
            &default_font,
            &to_px,
            &svgs,
            auto_marks,
            &mut used_svg_ids,
            global_models,
            &mut warnings,
        )?;
        items.push(item);
    }

    // --- vector obstacles ---
    let mut vector: Vec<(String, Prim)> = Vec::new();
    for layer in lookup(problem, "obstacles.vector")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let class = layer["class"].as_str().unwrap_or("ink").to_string();
        let r = source_opt(layer, "obstacles.vector", "r")
            .as_f64()
            .unwrap_or(2.0);
        let width = source_opt(layer, "obstacles.vector", "width")
            .as_f64()
            .unwrap_or(1.0);
        let even_odd =
            source_opt(layer, "obstacles.vector", "fill_rule").as_str() == Some("evenodd");
        for p in points_of(layer.get("points").unwrap_or(&Value::Null)) {
            vector.push((
                class.clone(),
                Prim::Disc {
                    c: to_px.apply(p),
                    r,
                },
            ));
        }
        for c in layer
            .get("circles")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let (x, y, cr) = (
                c[0].as_f64().unwrap_or(0.0),
                c[1].as_f64().unwrap_or(0.0),
                c[2].as_f64().unwrap_or(0.0),
            );
            vector.push((
                class.clone(),
                Prim::Disc {
                    c: to_px.apply(P::new(x, y)),
                    r: cr,
                },
            ));
        }
        for pl in layer
            .get("polylines")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let pts: Vec<P> = points_of(pl).into_iter().map(|p| to_px.apply(p)).collect();
            vector.push((
                class.clone(),
                Prim::Polyline {
                    points: pts,
                    hw: width * 0.5,
                    closed: false,
                },
            ));
        }
        for pg in layer
            .get("polygons")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let ring: Vec<P> = points_of(pg).into_iter().map(|p| to_px.apply(p)).collect();
            let bbox = crate::geom::bbox_of(&ring);
            vector.push((
                class.clone(),
                Prim::Polygon {
                    rings: vec![ring],
                    even_odd,
                    bbox,
                },
            ));
        }
        for rc in layer
            .get("rects")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let v: Vec<f64> = rc
                .as_array()
                .into_iter()
                .flatten()
                .map(|x| x.as_f64().unwrap_or(0.0))
                .collect();
            if v.len() == 4 {
                let a = to_px.apply(P::new(v[0], v[1]));
                let b = to_px.apply(P::new(v[0] + v[2], v[1] + v[3]));
                if to_px.0[1] == 0.0 && to_px.0[2] == 0.0 {
                    vector.push((
                        class.clone(),
                        Prim::Rect(Rect::new(
                            a.x.min(b.x),
                            a.y.min(b.y),
                            a.x.max(b.x),
                            a.y.max(b.y),
                        )),
                    ));
                } else {
                    let ring: Vec<P> = [
                        P::new(v[0], v[1]),
                        P::new(v[0] + v[2], v[1]),
                        P::new(v[0] + v[2], v[1] + v[3]),
                        P::new(v[0], v[1] + v[3]),
                    ]
                    .iter()
                    .map(|p| to_px.apply(*p))
                    .collect();
                    let bbox = crate::geom::bbox_of(&ring);
                    vector.push((
                        class.clone(),
                        Prim::Polygon {
                            rings: vec![ring],
                            even_odd: false,
                            bbox,
                        },
                    ));
                }
            }
        }
        for sh in layer
            .get("shapes")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let at = to_px.apply(P::new(
                sh["x"].as_f64().unwrap_or(0.0),
                sh["y"].as_f64().unwrap_or(0.0),
            ));
            let (shape, _) = mark_shape(sh, at, &to_px, &[], &mut warnings, "/obstacles/vector")?;
            vector.push((class.clone(), Prim::Shape(shape)));
        }
    }
    // SVG geometry
    let preset_rules: Vec<(String, String)> = o
        .preset
        .and_then(|p| p.get("svg_classes"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some((
                        r.get("selector")?.as_str()?.to_string(),
                        r.get("class")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    for (doc, src, ptr) in &svgs {
        let rules: Vec<(String, String)> = match src.get("classes").and_then(|v| v.as_array()) {
            Some(a) => a
                .iter()
                .filter_map(|r| {
                    Some((
                        r.get("selector")?.as_str()?.to_string(),
                        r.get("class")?.as_str()?.to_string(),
                    ))
                })
                .collect(),
            None => preset_rules.clone(),
        };
        let default_class = source_opt(src, "obstacles.svg", "default_class")
            .as_str()
            .unwrap_or("ink")
            .to_string();
        let geoms = doc
            .classify(&rules, &default_class, &used_svg_ids)
            .map_err(|(ri, m)| err(format!("{ptr}/classes/{ri}/selector"), "pattern", m))?;
        for (class, g) in geoms {
            vector.push((class, geom_to_prim(g)));
        }
    }

    // --- extent ---
    let max_dist_global = o.length("placement.max_distance").px(default_em);
    let extent = match canvas {
        Some(c) => c,
        None => {
            let mut bb = Rect::EMPTY;
            for it in &items {
                bb = bb.union(&it.shape.bbox());
                if let Some(a) = &it.area {
                    bb = bb.union(&a.shape.bbox());
                }
            }
            for (_, p) in &vector {
                bb = bb.union(&p.bbox());
            }
            if bb.is_empty() {
                bb = Rect::new(0.0, 0.0, 1.0, 1.0);
            }
            let grow = max_dist_global.max(20.0 * default_em);
            bb.inflate(grow)
        }
    };

    // --- label area ---
    let allow_outside = o.bool("canvas.allow_outside");
    let pad = o.length("canvas.padding").px(default_em);
    let region = problem
        .pointer("/canvas/region")
        .and_then(|r| r.as_array())
        .and_then(|r| {
            let v: Vec<f64> = r.iter().filter_map(|x| x.as_f64()).collect();
            (v.len() == 4).then(|| Rect::xywh(v[0], v[1], v[2], v[3]))
        });
    let label_area = match (canvas, allow_outside) {
        (Some(c), false) => {
            let base = region.unwrap_or(c);
            Some(base.inflate(-pad))
        }
        _ => None,
    };
    let leader_area = if allow_outside { None } else { canvas };

    // --- priority options ---
    let omission = match o.string("priority.omission").as_str() {
        "prefix" => Omission::Prefix,
        "weighted" => Omission::Weighted,
        _ => Omission::Strict,
    };
    let ties_s = o.string("priority.ties");
    let solver = SolverOpts::from(&o);
    let ties = match ties_s.as_str() {
        "id" => Ties::Id,
        "anchor_x" => Ties::AnchorX,
        "random" => Ties::Random(solver.seed),
        s if s.starts_with("random(") => Ties::Random(s[7..s.len() - 1].parse().unwrap_or(0)),
        _ => Ties::InputOrder,
    };
    let focus = lookup(problem, "priority.focus")
        .and_then(points_of_single)
        .map(|p| to_px.apply(p));

    // --- ladder ---
    let ladder: Vec<Step> = o
        .strings("degrade")
        .iter()
        .filter_map(|s| Step::parse(s))
        .collect();

    // --- auto preset ---
    let auto_crowded = if o.preset_name == "auto" && !user_set_models {
        o.preset.and_then(|p| p.get("auto")).map(|a| {
            let f = a
                .get("crowded_fraction")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.3);
            let names: Vec<String> = a
                .get("crowded_models")
                .and_then(|v| v.as_array())
                .map(|x| {
                    x.iter()
                        .filter_map(|s| s.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            (f, Models::from_names(&names))
        })
    } else {
        None
    };

    // --- warm start ---
    let mut warm = BTreeMap::new();
    for p in lookup(problem, "warm_start.placements")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
            let placed = p.get("placed").and_then(|v| v.as_bool()).unwrap_or(true);
            let b = p.get("box").and_then(|b| {
                Some(Rect::xywh(
                    b.get("x")?.as_f64()?,
                    b.get("y")?.as_f64()?,
                    b.get("w")?.as_f64()?,
                    b.get("h")?.as_f64()?,
                ))
            });
            warm.insert(id.to_string(), if placed { b } else { None });
        }
    }

    let grid_cell = o.get("solver.grid_cell").as_f64();

    Ok(Model {
        canvas,
        label_area,
        leader_area,
        extent,
        to_px,
        items,
        vector,
        rasters,
        avoid_label: o.map("avoid.label"),
        avoid_leader: o.map("avoid.leader"),
        avoid_buffer: o.map("avoid.buffer"),
        relaxable: o.strings("avoid.relaxable"),
        placement: PlacementOpts::from(&o),
        leaders: LeaderOpts::from(&o),
        weights: Weights::from(&o),
        solver,
        ladder,
        degrade: DegradeOpts::from(&o),
        output: OutputOpts::from(&o),
        omission,
        ties,
        band: o.f64("priority.band"),
        max_labels: o
            .get("priority.budget.max_labels")
            .as_u64()
            .map(|v| v as usize),
        max_ink_fraction: o.get("priority.budget.max_ink_fraction").as_f64(),
        focus,
        priority_value: o.get("priority"),
        auto_crowded,
        grid_cell,
        default_em,
        shaping: o.string("text.shaping"),
        warm,
        warnings,
        preset_name: o.preset_name.clone(),
        groups: Vec::new(),
        group_of: Vec::new(),
    })
}

fn points_of_single(v: &Value) -> Option<P> {
    Some(P::new(v.get(0)?.as_f64()?, v.get(1)?.as_f64()?))
}

/// Bare base64 (no `.`; file paths must carry an extension).
fn looks_base64(s: &str) -> bool {
    s.len() >= 16
        && s.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, b'+' | b'/' | b'=' | b'-' | b'_' | b'\n' | b'\r' | b' ')
        })
}

fn parse_color(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    let v = |a: &str| u8::from_str_radix(a, 16).ok();
    match h.len() {
        3 => {
            let r = v(&h[0..1])?;
            let g = v(&h[1..2])?;
            let b = v(&h[2..3])?;
            Some([r * 17, g * 17, b * 17])
        }
        6 => Some([v(&h[0..2])?, v(&h[2..4])?, v(&h[4..6])?]),
        _ => None,
    }
}

fn raster_opts(src: &Value, ptr: &str) -> Result<RasterOpts, BuildError> {
    let get = |k: &str| source_opt(src, "obstacles.raster", k);
    let mode = get("mode").as_str().unwrap_or("ink").to_string();
    let background = get("ink.background").as_str().and_then(parse_color);
    let ink_threshold = get("ink.threshold").as_f64().unwrap_or(0.12);
    let mode = match mode.as_str() {
        "alpha" => RasterMode::Alpha {
            threshold: get("alpha.threshold").as_f64().unwrap_or(0.1),
        },
        "cost" => RasterMode::Cost {
            invert: get("cost.invert").as_bool().unwrap_or(false),
        },
        "saliency" => RasterMode::Saliency,
        "classmap" => {
            let mut palette = Vec::new();
            if let Some(Value::Object(m)) = src.get("classmap") {
                for (k, v) in m {
                    let c = parse_color(k).ok_or_else(|| {
                        err(
                            format!("{ptr}/classmap"),
                            "pattern",
                            format!("invalid colour {k}"),
                        )
                    })?;
                    palette.push((c, v.as_str().unwrap_or("ink").to_string()));
                }
            }
            RasterMode::ClassMap {
                palette,
                tolerance: get("classmap_tolerance").as_f64().unwrap_or(0.08),
                unmatched_ink: get("unmatched").as_str() != Some("ignore"),
                background,
                ink_threshold,
            }
        }
        _ => RasterMode::Ink {
            background,
            threshold: ink_threshold,
            dilate: get("ink.dilate").as_u64().unwrap_or(1) as u32,
        },
    };
    let off = get("offset");
    Ok(RasterOpts {
        mode,
        class: get("class").as_str().unwrap_or("ink").to_string(),
        scale: get("scale").as_f64().unwrap_or(1.0),
        offset: P::new(
            off.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0),
            off.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
        ),
    })
}

fn geom_to_prim(g: Geom) -> Prim {
    match g {
        Geom::Polygon { rings, even_odd } => {
            let bbox = crate::geom::bbox_of(&rings.iter().flatten().copied().collect::<Vec<_>>());
            Prim::Polygon {
                rings,
                even_odd,
                bbox,
            }
        }
        Geom::Polyline {
            points,
            width,
            closed,
        } => Prim::Polyline {
            points,
            hw: width * 0.5,
            closed,
        },
        Geom::Rect(r) => Prim::Rect(r),
    }
}

/// Polygon rings of SVG geometry (fills; strokes become thin outlines; rects as rings).
fn geoms_to_rings(geoms: &[Geom]) -> Vec<Vec<P>> {
    let mut rings = Vec::new();
    for g in geoms {
        match g {
            Geom::Polygon { rings: r, .. } => rings.extend(r.iter().cloned()),
            Geom::Rect(r) => rings.push(r.corners().to_vec()),
            Geom::Polyline { points, .. } => {
                if points.len() >= 3 {
                    rings.push(points.clone());
                }
            }
        }
    }
    rings
}

/// Build a mark shape from a mark JSON object placed at `at` (canvas px).
pub fn mark_shape(
    m: &Value,
    at: P,
    to_px: &Affine,
    svgs: &[(Box<dyn SvgDoc>, &Value, String)],
    warnings: &mut Vec<Issue>,
    ptr: &str,
) -> Result<(Shape, bool), BuildError> {
    let f = |k: &str| m.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let shape = m.get("shape").and_then(|s| s.as_str()).unwrap_or("circle");
    Ok(match shape {
        "ellipse" => (Shape::ellipse(at, f("rx"), f("ry"), f("rotation")), false),
        "rect" => (
            Shape::rect(at, f("w"), f("h"), f("corner_radius"), f("rotation")),
            false,
        ),
        "polygon" => {
            let rel = m.get("relative").and_then(|v| v.as_bool()).unwrap_or(false);
            let map = |p: P| if rel { at + p } else { to_px.apply(p) };
            let mut rings = vec![points_of(&m["points"])
                .into_iter()
                .map(map)
                .collect::<Vec<_>>()];
            for h in m
                .get("holes")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                rings.push(points_of(h).into_iter().map(map).collect());
            }
            (Shape::polygon(rings, false, at), false)
        }
        "path" => {
            let rel = m.get("relative").and_then(|v| v.as_bool()).unwrap_or(false);
            let d = m.get("d").and_then(|v| v.as_str()).unwrap_or("");
            let subs = path::flatten(d, 0.25).map_err(|e| {
                err(
                    format!("{ptr}/d"),
                    "pattern",
                    format!("invalid path data at {}: {}", e.offset, e.message),
                )
            })?;
            let rings: Vec<Vec<P>> = subs
                .into_iter()
                .filter(|s| s.points.len() >= 3)
                .map(|s| {
                    s.points
                        .into_iter()
                        .map(|p| if rel { at + p } else { to_px.apply(p) })
                        .collect()
                })
                .collect();
            if rings.is_empty() {
                warnings.push(Issue::new(
                    ptr,
                    "ignored",
                    "path mark has no area; using a point",
                ));
                (Shape::circle(at, 0.0), false)
            } else {
                (Shape::polygon(rings, false, at), false)
            }
        }
        "icon" => {
            let w = f("w");
            let h = f("h");
            let tip = m
                .get("tip")
                .and_then(points_of_single)
                .unwrap_or(P::new(w * 0.5, h));
            let tl = at - tip;
            let ring = match m.get("silhouette") {
                Some(s) => points_of(s).into_iter().map(|p| tl + p).collect(),
                None => vec![
                    tl,
                    tl + P::new(w, 0.0),
                    tl + P::new(w, h),
                    tl + P::new(0.0, h),
                ],
            };
            (Shape::polygon(vec![ring], false, at), true)
        }
        "from_svg" => {
            let mut geoms = Vec::new();
            for (doc, _, _) in svgs {
                if let Some(id) = m.get("svg_id").and_then(|v| v.as_str()) {
                    if let Some(g) = doc.geometry_by_id(id) {
                        geoms.extend(g);
                    }
                } else if let Some(sel) = m.get("selector").and_then(|v| v.as_str()) {
                    geoms.extend(
                        doc.geometry_by_selector(sel)
                            .map_err(|e| err(format!("{ptr}/selector"), "pattern", e))?,
                    );
                }
            }
            let rings = geoms_to_rings(&geoms);
            if rings.is_empty() {
                warnings.push(Issue::new(
                    ptr,
                    "ignored",
                    "from_svg mark not found in the SVG background; using a point",
                ));
                (Shape::circle(at, 2.0), false)
            } else {
                (Shape::polygon(rings, false, at), false)
            }
        }
        _ => (Shape::circle(at, f("r")), false),
    })
}

#[allow(clippy::too_many_arguments)]
fn build_item(
    i: usize,
    it: &Value,
    ptr: &str,
    o: &Opts,
    default_font: &FontSel,
    to_px: &Affine,
    svgs: &[(Box<dyn SvgDoc>, &Value, String)],
    auto_marks: bool,
    used_svg_ids: &mut Vec<String>,
    global_models: Models,
    warnings: &mut Vec<Issue>,
) -> Result<Item, BuildError> {
    let id = it
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| i.to_string());
    let anchor_v = &it["anchor"];
    let label_v = &it["label"];
    // font: defaults ← label.font
    let font = font_over(default_font, label_v.get("font"));
    let em = font.size;
    let len_of = |key: &str, item_key: Option<&Value>| -> f64 {
        item_key
            .and_then(Length::from_value)
            .unwrap_or_else(|| o.length(key))
            .px(em)
    };
    let ip = it.get("placement");
    let padding = len_of("defaults.padding", label_v.get("padding"));
    let len = ItemLengths {
        padding,
        buffer: len_of("defaults.buffer", None),
        offset: len_of("placement.offset", ip.and_then(|p| p.get("offset"))),
        inner_padding: len_of("placement.inner_padding", None),
        max_distance: len_of("placement.max_distance", None),
        min_distance: len_of("placement.min_distance", None),
        leader_min: len_of("leaders.min_length", None),
        leader_max: len_of("leaders.max_length", None),
        anchor_gap: len_of("leaders.anchor_gap", None),
        clearance: len_of("leaders.clearance", None),
        boundary_gap: len_of("placement.boundary.gap", None),
        boundary_margin: len_of("placement.boundary.margin", None),
    };
    // anchor + mark
    let svg_id = it
        .get("svg_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let (anchor, shape, area, tip) = match anchor_v["type"].as_str() {
        Some("area") => {
            let mut rings = vec![points_of(&anchor_v["polygon"])
                .into_iter()
                .map(|p| to_px.apply(p))
                .collect::<Vec<_>>()];
            for h in anchor_v
                .get("holes")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                rings.push(points_of(h).into_iter().map(|p| to_px.apply(p)).collect());
            }
            let (pole, pole_dist) = polygon::polylabel(&rings, false, 0.5);
            let area_shape = Shape::polygon(rings, false, pole);
            let dot = match anchor_v.get("dot") {
                Some(m) => {
                    mark_shape(m, pole, to_px, svgs, warnings, &format!("{ptr}/anchor/dot"))?.0
                }
                None => Shape::circle(pole, 2.0),
            };
            (
                pole,
                dot,
                Some(Area {
                    shape: area_shape,
                    pole,
                    pole_dist,
                }),
                false,
            )
        }
        _ => {
            let at = to_px.apply(P::new(
                anchor_v["x"].as_f64().unwrap_or(0.0),
                anchor_v["y"].as_f64().unwrap_or(0.0),
            ));
            let mark = anchor_v
                .get("mark")
                .cloned()
                .unwrap_or_else(|| o.get("defaults.mark"));
            let mark = if auto_marks && svg_id.is_some() && anchor_v.get("mark").is_none() {
                serde_json::json!({"shape": "from_svg", "svg_id": svg_id.clone().unwrap()})
            } else {
                mark
            };
            if mark.get("shape").and_then(|s| s.as_str()) == Some("from_svg") {
                if let Some(sid) = mark.get("svg_id").and_then(|v| v.as_str()) {
                    used_svg_ids.push(sid.to_string());
                }
            }
            let (s, tip) = mark_shape(
                &mark,
                at,
                to_px,
                svgs,
                warnings,
                &format!("{ptr}/anchor/mark"),
            )?;
            (at, s, None, tip)
        }
    };
    // label
    let text_spec = |v: &Value, f: &FontSel| -> TextSpec {
        let wrap = match v.get("wrap") {
            Some(Value::Object(w)) => Some(WrapSpec {
                max_width: w
                    .get("max_width")
                    .and_then(Length::from_value)
                    .map(|l| l.px(f.size)),
                max_lines: w
                    .get("max_lines")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(1)
                    .max(1) as usize,
                balance: w.get("balance").and_then(|x| x.as_bool()).unwrap_or(true),
            }),
            Some(Value::Null) => None,
            _ => match o.get("defaults.wrap") {
                Value::Object(w) => Some(WrapSpec {
                    max_width: w
                        .get("max_width")
                        .and_then(Length::from_value)
                        .map(|l| l.px(f.size)),
                    max_lines: w
                        .get("max_lines")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(1)
                        .max(1) as usize,
                    balance: w.get("balance").and_then(|x| x.as_bool()).unwrap_or(true),
                }),
                _ => None,
            },
        };
        let explicit = match (
            v.get("width").and_then(|x| x.as_f64()),
            v.get("height").and_then(|x| x.as_f64()),
        ) {
            (Some(w), Some(h)) => {
                let lines = v
                    .get("lines")
                    .and_then(|l| l.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_else(|| {
                        vec![v
                            .get("text")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string()]
                    });
                Some((w, h, lines))
            }
            _ => None,
        };
        TextSpec {
            text: v
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            alternatives: v
                .get("alternatives")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            wrap,
            truncate: Truncate::parse(
                v.get("truncate")
                    .and_then(|t| t.as_str())
                    .unwrap_or(&o.string("defaults.truncate")),
            ),
            explicit,
            align: v
                .get("align")
                .and_then(|a| a.as_str())
                .unwrap_or("start")
                .to_string(),
            font: f.clone(),
        }
    };
    let fixed = |v: &Value| -> (FixedKind, f64, f64, LabelShape) {
        let kind = if v["type"].as_str() == Some("box") {
            FixedKind::Box
        } else {
            FixedKind::Icon
        };
        (
            kind,
            v["width"].as_f64().unwrap_or(0.0),
            v["height"].as_f64().unwrap_or(0.0),
            LabelShape::parse(v.get("shape").and_then(|s| s.as_str()), v.get("polygon")),
        )
    };
    let label = match label_v["type"].as_str() {
        Some("icon") | Some("box") => {
            let (kind, w, h, shape) = fixed(label_v);
            LabelSpec::Fixed { kind, w, h, shape }
        }
        Some("composite") => {
            let cfont = font.clone();
            let parts = label_v["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| match p["type"].as_str() {
                    Some("text") => PartSpec::Text(text_spec(p, &font_over(&cfont, p.get("font")))),
                    _ => {
                        let (kind, w, h, shape) = fixed(p);
                        PartSpec::Fixed { kind, w, h, shape }
                    }
                })
                .collect();
            LabelSpec::Composite {
                row: label_v.get("direction").and_then(|d| d.as_str()) != Some("column"),
                gap: label_v
                    .get("gap")
                    .and_then(Length::from_value)
                    .map(|l| l.px(em))
                    .unwrap_or(0.0),
                align: label_v
                    .get("align")
                    .and_then(|a| a.as_str())
                    .unwrap_or("center")
                    .to_string(),
                parts,
            }
        }
        _ => LabelSpec::Text(text_spec(label_v, &font)),
    };
    // per-item placement
    let models = ip
        .and_then(|p| p.get("models"))
        .and_then(|m| m.as_array())
        .map(|a| {
            Models::from_names(
                &a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or(global_models);
    let internal = InternalPolicy::parse(
        ip.and_then(|p| p.get("internal"))
            .and_then(|v| v.as_str())
            .unwrap_or(&o.string("placement.internal")),
    );
    let positions = position_order(
        ip.and_then(|p| p.get("position_order"))
            .unwrap_or(&o.get("placement.position_order")),
    );
    let keep_with = match it.get("keep_with") {
        Some(Value::String(s)) => Some(KeepWith::Set(s.clone())),
        Some(Value::Array(a)) => Some(KeepWith::Ids(
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect(),
        )),
        _ => None,
    };
    Ok(Item {
        index: i,
        id,
        anchor,
        shape,
        area,
        tip,
        label,
        font,
        len,
        models,
        internal,
        positions,
        attrs: it
            .get("attrs")
            .cloned()
            .unwrap_or(Value::Object(Default::default())),
        explicit_priority: it.get("priority").and_then(|v| v.as_f64()),
        explicit_tier: it.get("tier").and_then(|v| v.as_i64()),
        required: it
            .get("required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        group: it.get("group").and_then(|v| v.as_str()).map(str::to_string),
        keep_with,
        svg_id,
        raw: it.clone(),
    })
}
