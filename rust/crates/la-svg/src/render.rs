//! Document preparation (elements, style sheets, cascade) and rendering into primitives.
//! Mirrors `render.ts`.

use std::collections::BTreeMap;

use crate::css::{parse_declarations, parse_stylesheet, CssRule, Decl};
use crate::error::{SvgError, SvgErrorCode};
use crate::flatten::{self, Subpath};
use crate::geom::{Affine, BBox};
use crate::num::{parse_length, parse_number_list, Length};
use crate::path::parse_path;
use crate::selector::{complex_matches, MatchContext};
use crate::style::{cascade, compute, is_presentation_attribute, Computed, Specified};
use crate::transform::{
    parse_aspect_ratio, parse_transform, parse_view_box, view_box_transform, AspectRatio,
};
use crate::xml::{parse_xml, XmlDoc, XmlNode, NS_SVG, NS_XLINK};
use crate::{Element, Geometry, ParseOptions, Point, Primitive, Rect, Scene, DEFAULT_ADVANCE};

/// Maximum depth of the render tree (elements plus `<use>` instance levels); deeper
/// content is skipped with a `limit` warning.
pub(crate) const MAX_RENDER_DEPTH: u32 = 384;
/// Maximum number of rendered element visits (guards exponential `<use>` fan-out).
pub(crate) const MAX_VISITS: usize = 2_000_000;
/// Maximum number of flattened points.
pub(crate) const MAX_POINTS: usize = 8_000_000;
/// Viewport size when neither `width`/`height`, `viewBox` nor a canvas is given.
const DEFAULT_VIEWPORT: (f64, f64) = (300.0, 150.0);

/// The parsed document with resolved styles (independent of rendering). The elements
/// own the attribute strings (moved out of the XML tree); rendering only reads them.
pub(crate) struct Doc {
    pub elements: Vec<Element>,
    /// Child nodes (elements and text) of every element.
    pub children: Vec<Vec<XmlNode>>,
    pub is_svg: Vec<bool>,
    pub specified: Vec<Specified>,
    /// Computed styles along the document tree.
    pub styles: Vec<Computed>,
    pub xml_space: Vec<Option<bool>>,
    /// Index of the `href` (or else `xlink:href`) attribute in `elements[i].attributes`.
    pub href: Vec<Option<u32>>,
    pub ids: BTreeMap<String, usize>,
}

impl Doc {
    pub(crate) fn tag(&self, i: usize) -> &str {
        &self.elements[i].tag
    }

    /// An unprefixed attribute (`name` has no prefix, so it never matches `p:name`).
    pub(crate) fn attr(&self, i: usize, name: &str) -> Option<&str> {
        self.elements[i].attr(name)
    }

    fn href(&self, i: usize) -> Option<&str> {
        self.href[i].map(|k| self.elements[i].attributes[k as usize].1.as_str())
    }

    pub(crate) fn length(&self, i: usize, name: &str) -> Option<Length> {
        self.attr(i, name).and_then(parse_length)
    }

    pub(crate) fn transform(&self, i: usize) -> Affine {
        self.attr(i, "transform")
            .and_then(parse_transform)
            .unwrap_or(Affine::IDENTITY)
    }

    fn view_box(&self, i: usize) -> Option<[f64; 4]> {
        self.attr(i, "viewBox").and_then(parse_view_box)
    }

    fn aspect_ratio(&self, i: usize) -> AspectRatio {
        self.attr(i, "preserveAspectRatio")
            .map_or(AspectRatio::DEFAULT, parse_aspect_ratio)
    }
}

/// Elements plus side tables, built from the XML tree.
struct Built {
    elements: Vec<Element>,
    children: Vec<Vec<XmlNode>>,
    is_svg: Vec<bool>,
    xml_space: Vec<Option<bool>>,
    href: Vec<Option<u32>>,
}

/// Converts the XML tree into elements (moving its strings) plus side tables.
fn build(xml: XmlDoc) -> Built {
    let n = xml.elements.len();
    let mut elements: Vec<Element> = Vec::with_capacity(n);
    let mut children = Vec::with_capacity(n);
    let mut is_svg = Vec::with_capacity(n);
    let mut xml_space = Vec::with_capacity(n);
    let mut href = Vec::with_capacity(n);
    let namespaces = xml.namespaces;
    for x in xml.elements {
        let uri = x.ns.map(|k| namespaces[k as usize].as_str());
        let svg_ns = uri.is_none_or(|u| u.is_empty() || u == NS_SVG);
        is_svg.push(svg_ns);
        let mut space = None;
        let mut plain_href = None;
        let mut xlink_href = None;
        let mut id = None;
        let mut classes = Vec::new();
        for (k, a) in x.attrs.iter().enumerate() {
            match a.ns {
                None => match a.qname.as_str() {
                    "href" => plain_href = Some(k as u32),
                    "id" => id = Some(a.value.clone()),
                    "class" => {
                        classes = a
                            .value
                            .split_ascii_whitespace()
                            .map(str::to_string)
                            .collect()
                    }
                    _ => {}
                },
                Some(0) if a.local_name() == "space" => {
                    space = match a.value.as_str() {
                        "preserve" => Some(true),
                        "default" => Some(false),
                        _ => None,
                    }
                }
                Some(ns)
                    if xlink_href.is_none()
                        && namespaces[ns as usize] == NS_XLINK
                        && a.local_name() == "href" =>
                {
                    xlink_href = Some(k as u32)
                }
                _ => {}
            }
        }
        xml_space.push(space);
        href.push(plain_href.or(xlink_href));
        let mut tag = x.qname;
        tag.drain(..x.local);
        elements.push(Element {
            tag,
            namespace: if svg_ns {
                None
            } else {
                uri.map(str::to_string)
            },
            id,
            classes,
            attributes: x.attrs.into_iter().map(|a| (a.qname, a.value)).collect(),
            parent: x.parent,
            subtree_end: 0,
            drawn: false,
            filled: false,
            stroked: false,
            bbox: None,
        });
        children.push(x.children);
    }
    let mut ends: Vec<usize> = (1..=n).collect();
    for i in (0..n).rev() {
        if let Some(p) = elements[i].parent {
            if ends[i] > ends[p] {
                ends[p] = ends[i];
            }
        }
    }
    for (el, end) in elements.iter_mut().zip(ends) {
        el.subtree_end = end;
    }
    Built {
        elements,
        children,
        is_svg,
        xml_space,
        href,
    }
}

/// Parses and renders an SVG document.
///
/// Errors: `parse` (malformed XML), `invalid_value` (root is not `<svg>`, no positive
/// viewport, invalid options), `limit` (nesting, element, `<use>` expansion or point limits).
pub fn parse(svg: &str, options: &ParseOptions) -> Result<Scene, SvgError> {
    if !(options.tolerance > 0.0 && options.tolerance.is_finite()) {
        return Err(SvgError::new(
            SvgErrorCode::InvalidValue,
            "tolerance must be a positive number",
        ));
    }
    if let Some((w, h)) = options.canvas {
        if !(w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite()) {
            return Err(SvgError::new(
                SvgErrorCode::InvalidValue,
                "canvas width and height must be positive",
            ));
        }
    }
    if !(options.ascent.is_finite() && options.descent.is_finite()) {
        return Err(SvgError::new(
            SvgErrorCode::InvalidValue,
            "ascent and descent must be finite",
        ));
    }
    let xml = parse_xml(svg)?;
    let root_qname = xml.elements[0].qname.clone();
    let Built {
        mut elements,
        children,
        is_svg,
        xml_space,
        href,
    } = build(xml);
    let n = elements.len();
    if !is_svg[0] || elements[0].tag != "svg" {
        return Err(SvgError::new(
            SvgErrorCode::InvalidValue,
            format!("the root element is <{root_qname}>, expected <svg>"),
        ));
    }
    let mut ids = BTreeMap::new();
    for (i, el) in elements.iter().enumerate() {
        if let Some(id) = &el.id {
            ids.entry(id.clone()).or_insert(i);
        }
    }

    // Style sheets.
    let mut rules: Vec<CssRule> = Vec::new();
    for (i, el) in elements.iter().enumerate() {
        if !is_svg[i] || el.tag != "style" {
            continue;
        }
        let ty = el.attr("type").map(|t| t.trim().to_ascii_lowercase());
        if ty.is_some_and(|t| !t.is_empty() && t != "text/css") {
            continue;
        }
        let mut text = String::new();
        for c in &children[i] {
            if let XmlNode::Text(t) = c {
                text.push_str(t);
            }
        }
        rules.extend(parse_stylesheet(&text));
    }

    // Cascade and computed styles (document tree).
    let ctx0 = MatchContext {
        canvas_width: 0.0,
        canvas_height: 0.0,
    };
    let url_exists = |id: &str| ids.contains_key(id);
    let mut specified = Vec::with_capacity(n);
    let mut styles: Vec<Computed> = Vec::with_capacity(n);
    let initial = Computed::initial();
    let mut pres: Vec<(&str, &str)> = Vec::new();
    let mut matched: Vec<((u32, u32, u32), usize)> = Vec::new();
    let mut css: Vec<&[Decl]> = Vec::new();
    for i in 0..n {
        let el = &elements[i];
        let spec = if is_svg[i] {
            pres.clear();
            let mut inline: Vec<Decl> = Vec::new();
            for (name, value) in &el.attributes {
                if is_presentation_attribute(name) {
                    pres.push((name.as_str(), value.as_str()));
                } else if name == "style" {
                    inline = parse_declarations(value);
                }
            }
            matched.clear();
            for (k, r) in rules.iter().enumerate() {
                let best = r
                    .selectors
                    .iter()
                    .filter(|c| complex_matches(c, &elements, i, &ctx0))
                    .map(|c| c.specificity)
                    .max();
                if let Some(s) = best {
                    matched.push((s, k));
                }
            }
            matched.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
            css.clear();
            css.extend(matched.iter().map(|&(_, k)| rules[k].decls.as_slice()));
            cascade(&pres, &css, &inline, &url_exists)
        } else {
            Specified::default()
        };
        let parent_style = el.parent.map_or(&initial, |p| &styles[p]);
        let st = compute(&spec, parent_style, xml_space[i]);
        specified.push(spec);
        styles.push(st);
    }
    drop(pres);
    drop(css);
    for (i, el) in elements.iter_mut().enumerate() {
        // Images are ink; a line has no interior.
        el.filled = el.tag == "image" || (el.tag != "line" && styles[i].filled());
        el.stroked = styles[i].stroked();
    }

    let doc = Doc {
        elements,
        children,
        is_svg,
        specified,
        styles,
        xml_space,
        href,
        ids,
    };

    // Viewport and canvas.
    let view_box = doc.view_box(0);
    let (ref_w, ref_h) = view_box
        .map(|v| (v[2], v[3]))
        .or(options.canvas)
        .unwrap_or(DEFAULT_VIEWPORT);
    let wl = doc
        .length(0, "width")
        .filter(|l| l.v > 0.0)
        .map(|l| l.resolve(16.0, ref_w));
    let hl = doc
        .length(0, "height")
        .filter(|l| l.v > 0.0)
        .map(|l| l.resolve(16.0, ref_h));
    let (width, height) = match (wl, hl) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, view_box.map_or(ref_h, |v| w * v[3] / v[2])),
        (None, Some(h)) => (view_box.map_or(ref_w, |v| h * v[2] / v[3]), h),
        (None, None) => (ref_w, ref_h),
    };
    if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
        return Err(SvgError::new(
            SvgErrorCode::InvalidValue,
            "the SVG viewport has no positive size",
        ));
    }
    let (canvas_width, canvas_height) = options.canvas.unwrap_or((width, height));

    let default_measure = |text: &str, size: f64, _family: &str, _weight: u16| -> f64 {
        DEFAULT_ADVANCE * size * text.chars().count() as f64
    };
    let mut r = Renderer {
        doc: &doc,
        flags: vec![(false, None); n],
        prims: Vec::new(),
        warnings: Vec::new(),
        tol: options.tolerance,
        measure: options.measure.unwrap_or(&default_measure),
        ascent: options.ascent,
        descent: options.descent,
        shape: 0,
        visits: 0,
        points: 0,
        use_stack: Vec::new(),
        depth_warned: false,
    };

    let root_style = &doc.styles[0];
    if !root_style.display_none {
        let ctm = Affine::scale(canvas_width / width, canvas_height / height)
            .mul(&doc.transform(0))
            .mul(&view_box_transform(
                view_box,
                doc.aspect_ratio(0),
                width,
                height,
            ));
        let (vw, vh) = view_box.map_or((width, height), |v| (v[2], v[3]));
        let opacity = root_style.opacity;
        let ctx = Ctx {
            ctm,
            vw,
            vh,
            opacity,
            attr: None,
            instance: false,
            depth: 1,
        };
        let bbox = r.render_children(0, &ctx, root_style)?;
        r.flags[0] = (root_style.visible && opacity > 0.0, bbox.map(to_rect));
    }
    let Renderer {
        flags,
        prims,
        warnings,
        ..
    } = r;
    let Doc {
        mut elements, ids, ..
    } = doc;
    for (el, (drawn, bbox)) in elements.iter_mut().zip(flags) {
        el.drawn = drawn;
        el.bbox = bbox;
    }

    Ok(Scene {
        width,
        height,
        canvas_width,
        canvas_height,
        view_box,
        elements,
        primitives: prims,
        warnings,
        ids,
    })
}

pub(crate) fn to_rect(b: BBox) -> Rect {
    Rect {
        x: b.x0,
        y: b.y0,
        w: b.width(),
        h: b.height(),
    }
}

/// Rendering context of one element.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Ctx {
    /// User space → canvas.
    pub ctm: Affine,
    /// Size of the nearest viewport in user units (percentage reference).
    pub vw: f64,
    pub vh: f64,
    /// Cumulative opacity of the ancestors (excluding the element itself).
    pub opacity: f64,
    /// The outermost `<use>` this content is instantiated by.
    pub attr: Option<usize>,
    /// Inside a `<use>` instance (styles inherit from the `<use>`).
    pub instance: bool,
    pub depth: u32,
}

pub(crate) struct Renderer<'d, 'm> {
    pub doc: &'d Doc,
    /// (drawn, bbox) of every element, from direct rendering.
    flags: Vec<(bool, Option<Rect>)>,
    pub prims: Vec<Primitive>,
    pub warnings: Vec<SvgError>,
    pub tol: f64,
    pub measure: &'m dyn Fn(&str, f64, &str, u16) -> f64,
    pub ascent: f64,
    pub descent: f64,
    shape: usize,
    visits: usize,
    pub points: usize,
    use_stack: Vec<usize>,
    depth_warned: bool,
}

const RENDERABLE: [&str; 13] = [
    "g", "a", "switch", "svg", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "path", "text",
];

impl<'d> Renderer<'d, '_> {
    fn warn(&mut self, code: SvgErrorCode, message: String) {
        self.warnings.push(SvgError::new(code, message));
    }

    pub(crate) fn next_shape(&mut self) -> usize {
        let s = self.shape;
        self.shape += 1;
        s
    }

    pub(crate) fn add_points(&mut self, n: usize) -> Result<(), SvgError> {
        self.points += n;
        if self.points > MAX_POINTS {
            return Err(SvgError::new(
                SvgErrorCode::Limit,
                format!("SVG geometry exceeds {MAX_POINTS} points"),
            ));
        }
        Ok(())
    }

    /// The style of element `i` in this context.
    pub(crate) fn style_of(&self, i: usize, ctx: &Ctx, parent: &Computed) -> Computed {
        if ctx.instance {
            compute(&self.doc.specified[i], parent, self.doc.xml_space[i])
        } else {
            self.doc.styles[i].clone()
        }
    }

    fn render(&mut self, i: usize, ctx: &Ctx, parent: &Computed) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        if !doc.is_svg[i] {
            return Ok(None);
        }
        if ctx.depth > MAX_RENDER_DEPTH {
            if !self.depth_warned {
                self.depth_warned = true;
                self.warn(
                    SvgErrorCode::Limit,
                    format!("content nested deeper than {MAX_RENDER_DEPTH} levels was skipped"),
                );
            }
            return Ok(None);
        }
        self.visits += 1;
        if self.visits > MAX_VISITS {
            return Err(SvgError::new(
                SvgErrorCode::Limit,
                format!("SVG expands to more than {MAX_VISITS} rendered elements"),
            ));
        }
        let own;
        let style: &Computed = if ctx.instance {
            own = compute(&doc.specified[i], parent, doc.xml_space[i]);
            &own
        } else {
            &doc.styles[i]
        };
        if style.display_none {
            return Ok(None);
        }
        let opacity = ctx.opacity * style.opacity;
        let drawn = style.visible && opacity > 0.0;
        let bbox = match doc.tag(i) {
            "g" | "a" => {
                let c = Ctx {
                    ctm: ctx.ctm.mul(&doc.transform(i)),
                    opacity,
                    depth: ctx.depth + 1,
                    ..*ctx
                };
                self.render_children(i, &c, style)?
            }
            "switch" => {
                let c = Ctx {
                    ctm: ctx.ctm.mul(&doc.transform(i)),
                    opacity,
                    depth: ctx.depth + 1,
                    ..*ctx
                };
                match self.switch_child(i) {
                    Some(k) => self.render(k, &c, style)?,
                    None => None,
                }
            }
            "svg" => self.render_svg(i, ctx, style, opacity, None)?,
            "use" => self.render_use(i, ctx, style, opacity)?,
            "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "path" => {
                self.render_shape(i, ctx, style, drawn)?
            }
            "text" => self.render_text(i, ctx, style, opacity)?,
            "image" => self.render_image(i, ctx, style, drawn)?,
            _ => return Ok(None),
        };
        if !ctx.instance {
            self.flags[i] = (drawn, bbox.map(to_rect));
        }
        Ok(bbox)
    }

    fn render_children(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
    ) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        let mut bbox = None;
        for c in &doc.children[i] {
            if let XmlNode::Element(k) = c {
                let b = self.render(*k, ctx, style)?;
                bbox = BBox::union(bbox, b);
            }
        }
        Ok(bbox)
    }

    /// The child rendered by `<switch>`: the first renderable child that has no
    /// `requiredExtensions` and whose `systemLanguage` (if any) includes English.
    fn switch_child(&self, i: usize) -> Option<usize> {
        let doc = self.doc;
        for c in &doc.children[i] {
            let XmlNode::Element(k) = *c else { continue };
            if !doc.is_svg[k] {
                continue;
            }
            let tag = doc.tag(k);
            if !(RENDERABLE.contains(&tag) || tag == "image" || tag == "foreignObject") {
                continue;
            }
            if doc.attr(k, "requiredExtensions").is_some() {
                continue;
            }
            if let Some(langs) = doc.attr(k, "systemLanguage") {
                let ok = langs.split(',').any(|l| {
                    let l = l.trim().to_ascii_lowercase();
                    l == "en" || l.starts_with("en-")
                });
                if !ok {
                    continue;
                }
            }
            if tag == "foreignObject" {
                continue;
            }
            return Some(k);
        }
        None
    }

    /// A nested `<svg>` (also as a `<use>` target, with `size` overriding width/height).
    fn render_svg(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
        opacity: f64,
        size: Option<(Option<Length>, Option<Length>)>,
    ) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        let fs = style.font_size;
        let x = doc.length(i, "x").map_or(0.0, |l| l.resolve(fs, ctx.vw));
        let y = doc.length(i, "y").map_or(0.0, |l| l.resolve(fs, ctx.vh));
        let (ow, oh) = size.unwrap_or((None, None));
        let w = ow
            .or_else(|| doc.length(i, "width"))
            .map_or(ctx.vw, |l| l.resolve(fs, ctx.vw));
        let h = oh
            .or_else(|| doc.length(i, "height"))
            .map_or(ctx.vh, |l| l.resolve(fs, ctx.vh));
        if !(w > 0.0 && h > 0.0) {
            return Ok(None);
        }
        let vb = doc.view_box(i);
        let ctm = ctx
            .ctm
            .mul(&doc.transform(i))
            .mul(&Affine::translate(x, y))
            .mul(&view_box_transform(vb, doc.aspect_ratio(i), w, h));
        let (vw, vh) = vb.map_or((w, h), |v| (v[2], v[3]));
        let c = Ctx {
            ctm,
            vw,
            vh,
            opacity,
            depth: ctx.depth + 1,
            ..*ctx
        };
        self.render_children(i, &c, style)
    }

    fn render_use(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
        opacity: f64,
    ) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        let Some(href) = doc.href(i) else {
            return Ok(None);
        };
        let href = href.trim();
        let Some(id) = href.strip_prefix('#') else {
            self.warn(
                SvgErrorCode::Ignored,
                format!("<use> reference '{href}' outside the document was ignored"),
            );
            return Ok(None);
        };
        let Some(&t) = doc.ids.get(id) else {
            self.warn(
                SvgErrorCode::Ignored,
                format!("<use> reference '#{id}' not found"),
            );
            return Ok(None);
        };
        if (t <= i && i < doc.elements[t].subtree_end) || self.use_stack.contains(&t) {
            self.warn(
                SvgErrorCode::Ignored,
                format!("circular <use> reference '#{id}' was ignored"),
            );
            return Ok(None);
        }
        if !doc.is_svg[t] {
            return Ok(None);
        }
        let fs = style.font_size;
        let x = doc.length(i, "x").map_or(0.0, |l| l.resolve(fs, ctx.vw));
        let y = doc.length(i, "y").map_or(0.0, |l| l.resolve(fs, ctx.vh));
        let ctm = ctx.ctm.mul(&doc.transform(i)).mul(&Affine::translate(x, y));
        let attr = ctx.attr.or(Some(i));
        let base = Ctx {
            ctm,
            opacity,
            attr,
            instance: true,
            depth: ctx.depth + 1,
            ..*ctx
        };
        self.use_stack.push(t);
        let res = match doc.tag(t) {
            "symbol" => {
                let sym = compute(&doc.specified[t], style, doc.xml_space[t]);
                let w = doc
                    .length(i, "width")
                    .or_else(|| doc.length(t, "width"))
                    .map_or(ctx.vw, |l| l.resolve(fs, ctx.vw));
                let h = doc
                    .length(i, "height")
                    .or_else(|| doc.length(t, "height"))
                    .map_or(ctx.vh, |l| l.resolve(fs, ctx.vh));
                if w > 0.0 && h > 0.0 {
                    let vb = doc.view_box(t);
                    let m = ctm.mul(&view_box_transform(vb, doc.aspect_ratio(t), w, h));
                    let (vw, vh) = vb.map_or((w, h), |v| (v[2], v[3]));
                    let c = Ctx {
                        ctm: m,
                        vw,
                        vh,
                        opacity: opacity * sym.opacity,
                        ..base
                    };
                    self.render_children(t, &c, &sym)
                } else {
                    Ok(None)
                }
            }
            "svg" => {
                let st = compute(&doc.specified[t], style, doc.xml_space[t]);
                if st.display_none {
                    Ok(None)
                } else {
                    let size = (doc.length(i, "width"), doc.length(i, "height"));
                    self.render_svg(t, &base, &st, opacity * st.opacity, Some(size))
                }
            }
            _ => self.render(t, &base, style),
        };
        self.use_stack.pop();
        res
    }

    fn render_shape(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
        drawn: bool,
    ) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        let ctm = ctx.ctm.mul(&doc.transform(i));
        let fs = style.font_size;
        let diag = ((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2.0).sqrt();
        let lx = |name: &str| doc.length(i, name).map(|l| l.resolve(fs, ctx.vw));
        let ly = |name: &str| doc.length(i, name).map(|l| l.resolve(fs, ctx.vh));
        let tol = self.tol;
        let tag = doc.tag(i);
        let geometry: Option<Vec<Subpath>> = match tag {
            "rect" => {
                let x = lx("x").unwrap_or(0.0);
                let y = ly("y").unwrap_or(0.0);
                match (lx("width"), ly("height")) {
                    (Some(w), Some(h)) if w > 0.0 && h > 0.0 => {
                        let rx = lx("rx").filter(|v| *v >= 0.0);
                        let ry = ly("ry").filter(|v| *v >= 0.0);
                        let (rx, ry) = match (rx, ry) {
                            (None, None) => (0.0, 0.0),
                            (Some(a), None) => (a, a),
                            (None, Some(b)) => (b, b),
                            (Some(a), Some(b)) => (a, b),
                        };
                        let rx = if rx > w / 2.0 { w / 2.0 } else { rx };
                        let ry = if ry > h / 2.0 { h / 2.0 } else { ry };
                        flatten::rect(ctm, tol, x, y, w, h, rx, ry)
                    }
                    _ => return Ok(None),
                }
            }
            "circle" => {
                let cx = lx("cx").unwrap_or(0.0);
                let cy = ly("cy").unwrap_or(0.0);
                match doc.length(i, "r").map(|l| l.resolve(fs, diag)) {
                    Some(r) if r > 0.0 => flatten::ellipse(ctm, tol, cx, cy, r, r),
                    _ => return Ok(None),
                }
            }
            "ellipse" => {
                let cx = lx("cx").unwrap_or(0.0);
                let cy = ly("cy").unwrap_or(0.0);
                let (rx, ry) = match (lx("rx"), ly("ry")) {
                    (Some(a), Some(b)) => (a, b),
                    (Some(a), None) => (a, a),
                    (None, Some(b)) => (b, b),
                    (None, None) => return Ok(None),
                };
                if !(rx > 0.0 && ry > 0.0) {
                    return Ok(None);
                }
                flatten::ellipse(ctm, tol, cx, cy, rx, ry)
            }
            "line" => {
                let c = [
                    lx("x1").unwrap_or(0.0),
                    ly("y1").unwrap_or(0.0),
                    lx("x2").unwrap_or(0.0),
                    ly("y2").unwrap_or(0.0),
                ];
                flatten::poly(ctm, tol, &c, false)
            }
            "polyline" | "polygon" => {
                let (coords, _) = doc
                    .attr(i, "points")
                    .map(parse_number_list)
                    .unwrap_or_default();
                if coords.len() < 4 {
                    return Ok(None);
                }
                flatten::poly(ctm, tol, &coords, tag == "polygon")
            }
            "path" => {
                let segs = doc.attr(i, "d").map(parse_path).unwrap_or_default();
                flatten::path(ctm, tol, &segs)
            }
            _ => return Ok(None),
        };
        let Some(mut subpaths) = geometry else {
            return Ok(None);
        };
        let mut bbox: Option<BBox> = None;
        let mut count = 0;
        for s in &subpaths {
            bbox = BBox::union(bbox, BBox::of_points(&s.pts));
            count += s.pts.len();
        }
        if bbox.is_none() {
            return Ok(None);
        }
        self.add_points(count)?;
        if drawn {
            let shape = self.next_shape();
            let element = ctx.attr.unwrap_or(i);
            let fill = tag != "line" && style.filled();
            let mut stroke_width = 0.0;
            if style.stroked() {
                let w = style.stroke_width.resolve(fs, diag);
                stroke_width = if style.non_scaling {
                    w
                } else {
                    w * ctm.mean_scale()
                };
            }
            let stroke = stroke_width > 0.0 && stroke_width.is_finite();
            if fill {
                let rings: Vec<Vec<Point>> = if stroke {
                    subpaths
                        .iter()
                        .filter(|s| s.pts.len() >= 3)
                        .map(|s| s.pts.clone())
                        .collect()
                } else {
                    std::mem::take(&mut subpaths)
                        .into_iter()
                        .filter(|s| s.pts.len() >= 3)
                        .map(|s| s.pts)
                        .collect()
                };
                if !rings.is_empty() {
                    self.prims.push(Primitive {
                        element,
                        source: i,
                        shape,
                        geometry: Geometry::Polygon {
                            rings,
                            even_odd: style.even_odd,
                        },
                    });
                }
            }
            if stroke {
                for s in subpaths {
                    self.prims.push(Primitive {
                        element,
                        source: i,
                        shape,
                        geometry: Geometry::Polyline {
                            points: s.pts,
                            width: stroke_width,
                            closed: s.closed,
                        },
                    });
                }
            }
        }
        Ok(bbox)
    }

    fn render_text(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
        opacity: f64,
    ) -> Result<Option<BBox>, SvgError> {
        let ctm = ctx.ctm.mul(&self.doc.transform(i));
        let chunks = crate::text::layout(self, i, ctx, &ctm, style);
        let mut bbox: Option<BBox> = None;
        for c in &chunks {
            bbox = BBox::union(bbox, Some(c.all));
        }
        self.add_points(4 * chunks.len())?;
        if opacity > 0.0 && chunks.iter().any(|c| c.inked.is_some()) {
            let shape = self.next_shape();
            let element = ctx.attr.unwrap_or(i);
            for b in chunks.iter().filter_map(|c| c.inked) {
                self.prims.push(Primitive {
                    element,
                    source: i,
                    shape,
                    geometry: Geometry::Rect {
                        x: b.x0,
                        y: b.y0,
                        w: b.width(),
                        h: b.height(),
                    },
                });
            }
        }
        Ok(bbox)
    }

    fn render_image(
        &mut self,
        i: usize,
        ctx: &Ctx,
        style: &Computed,
        drawn: bool,
    ) -> Result<Option<BBox>, SvgError> {
        let doc: &'d Doc = self.doc;
        let fs = style.font_size;
        let x = doc.length(i, "x").map_or(0.0, |l| l.resolve(fs, ctx.vw));
        let y = doc.length(i, "y").map_or(0.0, |l| l.resolve(fs, ctx.vh));
        let (Some(w), Some(h)) = (
            doc.length(i, "width").map(|l| l.resolve(fs, ctx.vw)),
            doc.length(i, "height").map(|l| l.resolve(fs, ctx.vh)),
        ) else {
            return Ok(None);
        };
        if !(w > 0.0 && h > 0.0) {
            return Ok(None);
        }
        let ctm = ctx.ctm.mul(&doc.transform(i));
        let ring = vec![
            ctm.apply(x, y),
            ctm.apply(x + w, y),
            ctm.apply(x + w, y + h),
            ctm.apply(x, y + h),
        ];
        if !ring.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
            return Ok(None);
        }
        let bbox = BBox::of_points(&ring);
        self.add_points(4)?;
        if drawn {
            let shape = self.next_shape();
            self.prims.push(Primitive {
                element: ctx.attr.unwrap_or(i),
                source: i,
                shape,
                geometry: Geometry::Polygon {
                    rings: vec![ring],
                    even_odd: false,
                },
            });
        }
        Ok(bbox)
    }
}
