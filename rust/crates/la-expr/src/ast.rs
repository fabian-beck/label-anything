//! Syntax tree. Operator chains (`a || b || c`, `a + b - c`, `a.b[c].d()`) are flat
//! vectors, so the tree depth is bounded by the nesting limit and neither evaluation nor
//! `Drop` can recurse deeply.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Var {
    Attrs,
    Id,
    Index,
    Text,
    Priority,
    Tier,
    X,
    Y,
}

impl Var {
    pub(crate) fn lookup(name: &str) -> Option<Var> {
        Some(match name {
            "attrs" => Var::Attrs,
            "id" => Var::Id,
            "index" => Var::Index,
            "text" => Var::Text,
            "priority" => Var::Priority,
            "tier" => Var::Tier,
            "x" => Var::X,
            "y" => Var::Y,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Func {
    Abs,
    Min,
    Max,
    Log,
    Sqrt,
    Floor,
    Ceil,
    Round,
    Log1p,
    Len,
    Lower,
    Upper,
    Number,
    StartsWith,
    EndsWith,
    Contains,
    Coalesce,
}

impl Func {
    pub(crate) fn lookup(name: &str) -> Option<Func> {
        Some(match name {
            "abs" => Func::Abs,
            "min" => Func::Min,
            "max" => Func::Max,
            "log" => Func::Log,
            "sqrt" => Func::Sqrt,
            "floor" => Func::Floor,
            "ceil" => Func::Ceil,
            "round" => Func::Round,
            "log1p" => Func::Log1p,
            "len" => Func::Len,
            "lower" => Func::Lower,
            "upper" => Func::Upper,
            "number" => Func::Number,
            "startsWith" => Func::StartsWith,
            "endsWith" => Func::EndsWith,
            "contains" => Func::Contains,
            "coalesce" => Func::Coalesce,
            _ => return None,
        })
    }

    /// `(count, variadic)`: exactly `count` arguments, or at least `count` if variadic.
    pub(crate) fn arity(self) -> (usize, bool) {
        match self {
            Func::Min | Func::Max | Func::Coalesce => (1, true),
            Func::StartsWith | Func::EndsWith | Func::Contains => (2, false),
            _ => (1, false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
}

#[derive(Debug, Clone)]
pub(crate) enum PostOp {
    Member(String),
    Index(Node),
    /// Method call: the receiver is the first argument.
    Method(Func, Vec<Node>),
}

#[derive(Debug, Clone)]
pub(crate) enum Node {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Var(Var),
    List(Vec<Node>),
    Not(Box<Node>),
    Neg(Box<Node>),
    And(Vec<Node>),
    Or(Vec<Node>),
    Cmp(CmpOp, Box<Node>, Box<Node>),
    In {
        lhs: Box<Node>,
        list: Vec<Node>,
        negate: bool,
    },
    Arith {
        first: Box<Node>,
        rest: Vec<(ArithOp, Node)>,
    },
    Postfix {
        base: Box<Node>,
        ops: Vec<PostOp>,
    },
    Call(Func, Vec<Node>),
}
