//! Typed, resolved options (everything except per-item lengths).

use crate::options::Opts;
use serde_json::Value;

/// The 8 fixed label positions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Pos {
    Top,
    Right,
    Bottom,
    Left,
    TopRight,
    BottomRight,
    TopLeft,
    BottomLeft,
}

impl Pos {
    pub const ALL: [Pos; 8] = [
        Pos::Top,
        Pos::Right,
        Pos::Bottom,
        Pos::Left,
        Pos::TopRight,
        Pos::BottomRight,
        Pos::TopLeft,
        Pos::BottomLeft,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Pos::Top => "top",
            Pos::Right => "right",
            Pos::Bottom => "bottom",
            Pos::Left => "left",
            Pos::TopRight => "top-right",
            Pos::BottomRight => "bottom-right",
            Pos::TopLeft => "top-left",
            Pos::BottomLeft => "bottom-left",
        }
    }
    pub fn parse(s: &str) -> Option<Pos> {
        Pos::ALL.iter().copied().find(|p| p.name() == s)
    }
    /// Angle in degrees, counter-clockwise on screen from +x (right = 0, top = 90).
    pub fn angle(self) -> f64 {
        match self {
            Pos::Right => 0.0,
            Pos::TopRight => 45.0,
            Pos::Top => 90.0,
            Pos::TopLeft => 135.0,
            Pos::Left => 180.0,
            Pos::BottomLeft => 225.0,
            Pos::Bottom => 270.0,
            Pos::BottomRight => 315.0,
        }
    }
    /// Screen direction (y down), not normalized: components in {-1, 0, 1}.
    pub fn dir(self) -> crate::geom::P {
        use crate::geom::P;
        match self {
            Pos::Top => P::new(0.0, -1.0),
            Pos::Right => P::new(1.0, 0.0),
            Pos::Bottom => P::new(0.0, 1.0),
            Pos::Left => P::new(-1.0, 0.0),
            Pos::TopRight => P::new(1.0, -1.0),
            Pos::BottomRight => P::new(1.0, 1.0),
            Pos::TopLeft => P::new(-1.0, -1.0),
            Pos::BottomLeft => P::new(-1.0, 1.0),
        }
    }
    /// Index in angular order starting at `Right` and going counter-clockwise.
    pub fn angular_index(self) -> usize {
        (self.angle() / 45.0) as usize
    }
    pub fn from_angular_index(i: usize) -> Pos {
        [
            Pos::Right,
            Pos::TopRight,
            Pos::Top,
            Pos::TopLeft,
            Pos::Left,
            Pos::BottomLeft,
            Pos::Bottom,
            Pos::BottomRight,
        ][i % 8]
    }
}

/// Perceptual order (Bobák et al. 2026, PerceptPPO-like).
pub const PERCEPTUAL: [Pos; 8] = [
    Pos::Top,
    Pos::Right,
    Pos::Bottom,
    Pos::Left,
    Pos::TopRight,
    Pos::BottomRight,
    Pos::TopLeft,
    Pos::BottomLeft,
];
/// Cartographic (Imhof) order.
pub const CARTOGRAPHIC: [Pos; 8] = [
    Pos::TopRight,
    Pos::TopLeft,
    Pos::BottomRight,
    Pos::BottomLeft,
    Pos::Right,
    Pos::Left,
    Pos::Top,
    Pos::Bottom,
];

/// Position order: ranks of the enabled fixed positions.
pub fn position_order(v: &Value) -> Vec<Pos> {
    match v {
        Value::String(s) if s == "cartographic" => CARTOGRAPHIC.to_vec(),
        Value::Array(a) => {
            let mut out = Vec::new();
            for p in a.iter().filter_map(|p| p.as_str()).filter_map(Pos::parse) {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
            if out.is_empty() {
                PERCEPTUAL.to_vec()
            } else {
                out
            }
        }
        _ => PERCEPTUAL.to_vec(),
    }
}

/// Candidate models as a bit set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Models(pub u8);

impl Models {
    pub const ADJACENT: u8 = 1;
    pub const SLIDER: u8 = 2;
    pub const INTERNAL: u8 = 4;
    pub const DISTANT: u8 = 8;
    pub const BOUNDARY: u8 = 16;
    pub fn from_names(names: &[String]) -> Models {
        let mut m = 0u8;
        for n in names {
            m |= match n.as_str() {
                "adjacent" => Self::ADJACENT,
                "slider" => Self::SLIDER,
                "internal" => Self::INTERNAL,
                "distant" => Self::DISTANT,
                "boundary" => Self::BOUNDARY,
                _ => 0,
            };
        }
        Models(m)
    }
    #[inline]
    pub fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }
    #[inline]
    pub fn with(self, bit: u8) -> Models {
        Models(self.0 | bit)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InternalPolicy {
    Auto,
    Prefer,
    Allow,
    Never,
}

impl InternalPolicy {
    pub fn parse(s: &str) -> InternalPolicy {
        match s {
            "prefer" => InternalPolicy::Prefer,
            "allow" => InternalPolicy::Allow,
            "never" => InternalPolicy::Never,
            _ => InternalPolicy::Auto,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaderStyle {
    Straight,
    Angles,
    Orthogonal,
    Elbow,
    Curved,
}

impl LeaderStyle {
    pub fn parse(s: &str) -> LeaderStyle {
        match s {
            "angles" => LeaderStyle::Angles,
            "orthogonal" => LeaderStyle::Orthogonal,
            "elbow" => LeaderStyle::Elbow,
            "curved" => LeaderStyle::Curved,
            _ => LeaderStyle::Straight,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            LeaderStyle::Straight => "straight",
            LeaderStyle::Angles => "angles",
            LeaderStyle::Orthogonal => "orthogonal",
            LeaderStyle::Elbow => "elbow",
            LeaderStyle::Curved => "curved",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Port {
    Nearest,
    SideCenter,
    Baseline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attach {
    Auto,
    Boundary,
    Center,
    Tip,
}

#[derive(Clone, Debug)]
pub struct LeaderOpts {
    pub style: LeaderStyle,
    pub angles: Vec<f64>,
    pub port: Port,
    pub attach: Attach,
    pub min_angle_between: f64,
    pub width: f64,
}

impl LeaderOpts {
    pub fn from(o: &Opts) -> LeaderOpts {
        let mut angles: Vec<f64> = o
            .numbers("leaders.angles")
            .into_iter()
            .map(|a| a.rem_euclid(360.0))
            .collect();
        crate::sort::sort_by(&mut angles, |a, b| crate::math::cmp_f64(*a, *b));
        angles.dedup();
        LeaderOpts {
            style: LeaderStyle::parse(&o.string("leaders.style")),
            angles,
            port: match o.string("leaders.port").as_str() {
                "side-center" => Port::SideCenter,
                "baseline" => Port::Baseline,
                _ => Port::Nearest,
            },
            attach: match o.string("leaders.attach").as_str() {
                "boundary" => Attach::Boundary,
                "center" => Attach::Center,
                "tip" => Attach::Tip,
                _ => Attach::Auto,
            },
            min_angle_between: o.f64("leaders.min_angle_between"),
            width: o.f64("leaders.width"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Omission {
    Strict,
    Prefix,
    Weighted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ties {
    InputOrder,
    Id,
    AnchorX,
    Random(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    Auto,
    Greedy,
    Local,
    Exact,
}

/// One degradation-ladder step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Alternatives,
    Wrap,
    Truncate,
    Distant,
    Boundary,
    EvictLower,
    Shrink(f64),
    SoftOverlap,
    Omit,
}

impl Step {
    pub fn parse(s: &str) -> Option<Step> {
        Some(match s {
            "alternatives" => Step::Alternatives,
            "wrap" => Step::Wrap,
            "truncate" => Step::Truncate,
            "distant" => Step::Distant,
            "boundary" => Step::Boundary,
            "evict_lower" => Step::EvictLower,
            "soft_overlap" => Step::SoftOverlap,
            "omit" => Step::Omit,
            _ => Step::Shrink(s.strip_prefix("shrink:")?.parse().ok()?),
        })
    }
    pub fn name(&self) -> String {
        match self {
            Step::Alternatives => "alternatives".into(),
            Step::Wrap => "wrap".into(),
            Step::Truncate => "truncate".into(),
            Step::Distant => "distant".into(),
            Step::Boundary => "boundary".into(),
            Step::EvictLower => "evict_lower".into(),
            Step::Shrink(f) => format!("shrink:{f}"),
            Step::SoftOverlap => "soft_overlap".into(),
            Step::Omit => "omit".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Weights {
    pub position: f64,
    pub distance: f64,
    pub leader: f64,
    pub leader_length: f64,
    pub bends: f64,
    pub shape: f64,
    pub edge: f64,
    pub ambiguity: f64,
    pub lookahead: f64,
    pub starve: f64,
    pub contrast: f64,
    pub straddle: f64,
    pub foreign: f64,
    pub leader_borders: f64,
    pub stability: f64,
}

impl Weights {
    pub fn from(o: &Opts) -> Weights {
        Weights {
            position: o.f64("weights.position"),
            distance: o.f64("weights.distance"),
            leader: o.f64("weights.leader"),
            leader_length: o.f64("weights.leader_length"),
            bends: o.f64("weights.bends"),
            shape: o.f64("weights.shape"),
            edge: o.f64("weights.edge"),
            ambiguity: o.f64("weights.ambiguity"),
            lookahead: o.f64("weights.lookahead"),
            starve: o.f64("weights.starve"),
            contrast: o.f64("weights.contrast"),
            straddle: o.f64("weights.straddle"),
            foreign: o.f64("weights.foreign"),
            leader_borders: o.f64("weights.leader_borders"),
            stability: o.f64("weights.stability"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SolverOpts {
    pub strategy: Strategy,
    pub time_budget_ms: f64,
    pub max_iterations: u64,
    pub seed: u64,
}

impl SolverOpts {
    pub fn from(o: &Opts) -> SolverOpts {
        SolverOpts {
            strategy: match o.string("solver.strategy").as_str() {
                "greedy" => Strategy::Greedy,
                "local" => Strategy::Local,
                "exact" => Strategy::Exact,
                _ => Strategy::Auto,
            },
            time_budget_ms: o.f64("solver.time_budget_ms"),
            max_iterations: o.get("solver.max_iterations").as_u64().unwrap_or(200_000),
            seed: o.get("solver.seed").as_u64().unwrap_or(0),
        }
    }
}

#[derive(Clone, Debug)]
pub struct OutputOpts {
    pub debug_svg: bool,
    pub cost_breakdown: bool,
    pub candidates: bool,
    pub item_shape: bool,
}

impl OutputOpts {
    pub fn from(o: &Opts) -> OutputOpts {
        OutputOpts {
            debug_svg: o.bool("output.debug_svg"),
            cost_breakdown: o.bool("output.cost_breakdown"),
            candidates: o.bool("output.candidates"),
            item_shape: o.bool("output.item_shape"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DegradeOpts {
    pub min_scale: f64,
    pub wrap_max_lines: usize,
    pub soft_overlap_weight: f64,
}

impl DegradeOpts {
    pub fn from(o: &Opts) -> DegradeOpts {
        DegradeOpts {
            min_scale: o.f64("degrade_options.min_scale"),
            wrap_max_lines: o
                .get("degrade_options.wrap_max_lines")
                .as_u64()
                .unwrap_or(3)
                .max(1) as usize,
            soft_overlap_weight: o.f64("degrade_options.soft_overlap_weight"),
        }
    }
}

/// When crowds get fan labels (spec §6.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FanMode {
    /// Crowds of items left without a label, when the column places more labels.
    Auto,
    /// Every crowd of two or more items, when the column places at least as many.
    Always,
    Off,
}

/// Boundary model options.
#[derive(Clone, Debug)]
pub struct BoundaryOpts {
    pub sides: Vec<String>,
    pub spread: bool,
}

/// Placement options that do not depend on the label's font size.
#[derive(Clone, Debug)]
pub struct PlacementOpts {
    pub slider_per_gap: usize,
    pub k_distant: usize,
    pub distant_rings: usize,
    pub distant_directions: usize,
    pub free_space_seeds: bool,
    pub internal_circle_ratio: f64,
    pub prune_factor: f64,
    pub boundary: BoundaryOpts,
    pub fan: FanMode,
    /// `placement.max_foreign`: the largest share of the box of an area item's label (not
    /// an internal one) or of a label on a leader that may lie in other items' regions
    /// (spec §4.8).
    pub max_foreign: f64,
}

impl PlacementOpts {
    pub fn from(o: &Opts) -> PlacementOpts {
        PlacementOpts {
            slider_per_gap: o.get("placement.slider_per_quadrant").as_u64().unwrap_or(4) as usize,
            k_distant: o.get("placement.k_distant").as_u64().unwrap_or(24) as usize,
            distant_rings: o
                .get("placement.distant_rings")
                .as_u64()
                .unwrap_or(4)
                .max(1) as usize,
            distant_directions: o
                .get("placement.distant_directions")
                .as_u64()
                .unwrap_or(16)
                .max(4) as usize,
            free_space_seeds: o.bool("placement.free_space_seeds"),
            internal_circle_ratio: o.f64("placement.internal_circle_ratio"),
            prune_factor: o.f64("placement.prune_factor").max(1.0),
            boundary: BoundaryOpts {
                sides: o.strings("placement.boundary.sides"),
                spread: o.string("placement.boundary.align") == "spread",
            },
            fan: match o.string("placement.fan").as_str() {
                "always" => FanMode::Always,
                "off" => FanMode::Off,
                _ => FanMode::Auto,
            },
            max_foreign: o.f64("placement.max_foreign"),
        }
    }
}
