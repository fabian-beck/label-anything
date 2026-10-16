//! Recursive-descent parser for `spec/expr.peg`.
//!
//! Nesting is bounded by [`MAX_DEPTH`], and the recursion is kept cheap so that even
//! unoptimized builds stay far inside a 2 MiB thread stack: parse functions push their
//! result onto an explicit node stack and return `Result<(), Box<ExprError>>` (one word),
//! and all non-recursive work (operator chains, literals, error messages) lives in
//! `#[inline(never)]` helpers. One nesting level costs five or six frames:
//! `or` → `not` → `arith` → `unary` → `group` / `list_items` / `postfix` / `ident` (→
//! `call_args`) → `or`. The TypeScript parser has the same functions (returning nodes).

use crate::ast::{ArithOp, CmpOp, Func, Node, PostOp, Var};
use crate::error::{ExprError, EXPR_ARITY, EXPR_UNKNOWN_IDENTIFIER};
use crate::lexer::{describe, lex, Tok, Token};

/// Maximum nesting depth. Each `(`…`)` group, list literal, index `[`…`]`, argument
/// list and each prefix `!` / `-` opens one level; opening level 257 is an
/// `expr_syntax` error at the offending token.
pub const MAX_DEPTH: usize = 256;

type PResult<T = ()> = Result<T, Box<ExprError>>;

pub(crate) fn parse_node(src: &str) -> Result<Node, ExprError> {
    let chars: Vec<char> = src.chars().collect();
    let lexed = lex(&chars);
    let mut p = Parser {
        toks: lexed.tokens,
        pos: 0,
        depth: 0,
        lex_error: lexed.error,
        nodes: Vec::new(),
    };
    p.or().map_err(|e| *e)?;
    if p.peek() != &Tok::Eof {
        return Err(*p.unexpected("end of input"));
    }
    Ok(p.pop())
}

struct Parser {
    toks: Vec<Token>,
    pos: usize,
    depth: usize,
    lex_error: Option<ExprError>,
    /// Operand stack: every parse function pushes exactly one node on success.
    nodes: Vec<Node>,
}

#[inline(never)]
fn check_arity(f: Func, name: &str, n: usize, offset: usize) -> PResult {
    let (count, variadic) = f.arity();
    if (variadic && n >= count) || (!variadic && n == count) {
        return Ok(());
    }
    let plural = if count == 1 { "" } else { "s" };
    let least = if variadic { "at least " } else { "" };
    Err(Box::new(ExprError::new(
        EXPR_ARITY,
        offset,
        format!("{name}() takes {least}{count} argument{plural}, got {n}"),
    )))
}

#[inline(never)]
fn lookup_function(name: &str, offset: usize) -> PResult<Func> {
    Func::lookup(name).ok_or_else(|| {
        Box::new(ExprError::new(
            EXPR_UNKNOWN_IDENTIFIER,
            offset,
            format!("unknown function '{name}'"),
        ))
    })
}

enum CmpKind {
    None,
    Cmp(CmpOp),
    In(bool),
}

/// Operator bookkeeping of one `+ - * / %` chain (a sum of products) on the node stack.
#[derive(Default)]
struct ArithOps {
    /// `+`/`-` before the 2nd, 3rd, … product.
    add: Vec<ArithOp>,
    /// `*`/`/`/`%` inside the current product.
    mul: Vec<ArithOp>,
    /// Stack index of the current product's first factor.
    product_start: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos].tok
    }

    fn offset(&self) -> usize {
        self.toks[self.pos].offset
    }

    fn bump(&mut self) {
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
    }

    fn pop(&mut self) -> Node {
        self.nodes.pop().unwrap_or(Node::Null)
    }

    fn pop_n(&mut self, n: usize) -> Vec<Node> {
        let at = self.nodes.len().saturating_sub(n);
        self.nodes.split_off(at)
    }

    /// The error for the current token: the lexer's error if the lexer stopped here,
    /// otherwise "expected …, found …".
    #[inline(never)]
    fn unexpected(&self, expected: &str) -> Box<ExprError> {
        if self.peek() == &Tok::Error {
            if let Some(e) = &self.lex_error {
                return Box::new(e.clone());
            }
        }
        Box::new(ExprError::syntax(
            self.offset(),
            format!("expected {expected}, found {}", describe(self.peek())),
        ))
    }

    #[inline(never)]
    fn expect(&mut self, tok: Tok, what: &str) -> PResult {
        if self.peek() != &tok {
            return Err(self.unexpected(what));
        }
        self.bump();
        Ok(())
    }

    /// Opens a nesting level at the current token.
    #[inline(never)]
    fn enter(&mut self) -> PResult {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(Box::new(ExprError::syntax(
                self.offset(),
                format!("expression nested too deeply (more than {MAX_DEPTH} levels)"),
            )));
        }
        Ok(())
    }

    /// Consumes prefix operators `tok` (each opens a nesting level); returns the count.
    #[inline(never)]
    fn prefixes(&mut self, tok: &Tok) -> PResult<usize> {
        let mut n = 0;
        while self.peek() == tok {
            self.enter()?;
            self.bump();
            n += 1;
        }
        Ok(n)
    }

    /// Applies `n` prefix operators to the top node and closes their levels.
    #[inline(never)]
    fn wrap(&mut self, n: usize, neg: bool) {
        for _ in 0..n {
            let inner = Box::new(self.pop());
            self.nodes.push(if neg {
                Node::Neg(inner)
            } else {
                Node::Not(inner)
            });
            self.depth -= 1;
        }
    }

    #[inline(never)]
    fn logic_op(&mut self) -> Option<bool> {
        let is_or = match self.peek() {
            Tok::OrOr => true,
            Tok::AndAnd => false,
            _ => return None,
        };
        self.bump();
        Some(is_or)
    }

    /// Replaces the nodes from `from` by `And(...)` / `Or(...)` if there is more than one.
    #[inline(never)]
    fn close_logic(&mut self, from: usize, or: bool) {
        if self.nodes.len() > from + 1 {
            let items = self.nodes.split_off(from);
            self.nodes.push(if or {
                Node::Or(items)
            } else {
                Node::And(items)
            });
        }
    }

    #[inline(never)]
    fn arith_op(&mut self) -> Option<ArithOp> {
        let op = match self.peek() {
            Tok::Plus => ArithOp::Add,
            Tok::Minus => ArithOp::Sub,
            Tok::Star => ArithOp::Mul,
            Tok::Slash => ArithOp::Div,
            Tok::Percent => ArithOp::Rem,
            _ => return None,
        };
        self.bump();
        Some(op)
    }

    /// Replaces the nodes from `from` by one flat `Arith` chain with operators `ops`.
    fn close_arith(&mut self, from: usize, ops: Vec<ArithOp>) {
        if ops.is_empty() {
            return;
        }
        let mut items = self.nodes.split_off(from).into_iter();
        let first = items.next().unwrap_or(Node::Null);
        let rest = ops.into_iter().zip(items).collect();
        self.nodes.push(Node::Arith {
            first: Box::new(first),
            rest,
        });
    }

    /// Records operator `op` whose right operand was just pushed.
    #[inline(never)]
    fn arith_push(&mut self, ops: &mut ArithOps, op: ArithOp) {
        if matches!(op, ArithOp::Add | ArithOp::Sub) {
            let operand = self.pop();
            self.close_arith(ops.product_start, std::mem::take(&mut ops.mul));
            ops.add.push(op);
            ops.product_start += 1;
            self.nodes.push(operand);
        } else {
            ops.mul.push(op);
        }
    }

    #[inline(never)]
    fn arith_finish(&mut self, start: usize, ops: ArithOps) {
        self.close_arith(ops.product_start, ops.mul);
        self.close_arith(start, ops.add);
    }

    /// After the left operand of `Cmp`: consumes a comparison operator, `in` or
    /// `not in` (stopping in front of the list).
    #[inline(never)]
    fn cmp_kind(&mut self) -> PResult<CmpKind> {
        let op = match self.peek() {
            Tok::EqEq => CmpOp::Eq,
            Tok::NotEq => CmpOp::Ne,
            Tok::Lt => CmpOp::Lt,
            Tok::Le => CmpOp::Le,
            Tok::Gt => CmpOp::Gt,
            Tok::Ge => CmpOp::Ge,
            Tok::In | Tok::Not => {
                let negate = self.peek() == &Tok::Not;
                self.bump();
                if negate {
                    self.expect(Tok::In, "'in' after 'not'")?;
                }
                if self.peek() != &Tok::LBracket {
                    return Err(self.unexpected("'[' after 'in'"));
                }
                return Ok(CmpKind::In(negate));
            }
            _ => return Ok(CmpKind::None),
        };
        self.bump();
        Ok(CmpKind::Cmp(op))
    }

    #[inline(never)]
    fn make_cmp(&mut self, op: CmpOp) {
        let rhs = self.pop();
        let lhs = self.pop();
        self.nodes.push(Node::Cmp(op, Box::new(lhs), Box::new(rhs)));
    }

    #[inline(never)]
    fn make_in(&mut self, n: usize, negate: bool) {
        let list = self.pop_n(n);
        let lhs = self.pop();
        self.nodes.push(Node::In {
            lhs: Box::new(lhs),
            list,
            negate,
        });
    }

    #[inline(never)]
    fn make_list(&mut self, n: usize) {
        let items = self.pop_n(n);
        self.nodes.push(Node::List(items));
    }

    /// Number, string, `true`, `false`, `null` (anything else is an error here).
    #[inline(never)]
    fn literal(&mut self) -> PResult {
        let node = match self.peek() {
            Tok::Num(v) => Node::Num(*v),
            Tok::Str(s) => Node::Str(s.clone()),
            Tok::True => Node::Bool(true),
            Tok::False => Node::Bool(false),
            Tok::Null => Node::Null,
            _ => return Err(self.unexpected("an expression")),
        };
        self.bump();
        self.nodes.push(node);
        Ok(())
    }

    /// Consumes an identifier token and returns its name and offset.
    #[inline(never)]
    fn name(&mut self, what: &str) -> PResult<(String, usize)> {
        let off = self.offset();
        let name = match self.peek() {
            Tok::Ident(name) => name.clone(),
            _ => return Err(self.unexpected(what)),
        };
        self.bump();
        Ok((name, off))
    }

    /// A variable, after its name was consumed.
    #[inline(never)]
    fn variable(&mut self, name: &str, offset: usize) -> PResult {
        match Var::lookup(name) {
            Some(v) => {
                self.nodes.push(Node::Var(v));
                Ok(())
            }
            None => Err(Box::new(ExprError::new(
                EXPR_UNKNOWN_IDENTIFIER,
                offset,
                format!("unknown identifier '{name}'"),
            ))),
        }
    }

    #[inline(never)]
    fn make_postfix(&mut self, ops: Vec<PostOp>) {
        if !ops.is_empty() {
            let base = self.pop();
            self.nodes.push(Node::Postfix {
                base: Box::new(base),
                ops,
            });
        }
    }

    /// After a list item: `,` → Ok(true) (more items), `close` → Ok(false), else error.
    #[inline(never)]
    fn separator(&mut self, close: &Tok, what: &str) -> PResult<bool> {
        if self.peek() == &Tok::Comma {
            self.bump();
            return Ok(true);
        }
        if self.peek() == close {
            self.bump();
            return Ok(false);
        }
        Err(self.unexpected(what))
    }

    // ---- recursive productions ---------------------------------------------------

    /// `Or <- And ('||' And)*`, `And <- Not ('&&' Not)*`
    fn or(&mut self) -> PResult {
        let start = self.nodes.len();
        let mut group = start;
        self.not()?;
        while let Some(is_or) = self.logic_op() {
            if is_or {
                self.close_logic(group, false);
                group += 1;
            }
            self.not()?;
        }
        self.close_logic(group, false);
        self.close_logic(start, true);
        Ok(())
    }

    /// `Not <- '!' Not / Cmp`, `Cmp <- Add (CmpOp Add / 'in' List / 'not' 'in' List)?`
    fn not(&mut self) -> PResult {
        let nots = self.prefixes(&Tok::Bang)?;
        self.arith()?;
        match self.cmp_kind()? {
            CmpKind::None => {}
            CmpKind::Cmp(op) => {
                self.arith()?;
                self.make_cmp(op);
            }
            CmpKind::In(negate) => {
                let n = self.list_items()?;
                self.make_in(n, negate);
            }
        }
        self.wrap(nots, false);
        Ok(())
    }

    /// `Add <- Mul (('+' / '-') Mul)*`, `Mul <- Unary (('*' / '/' / '%') Unary)*`
    fn arith(&mut self) -> PResult {
        let start = self.nodes.len();
        let mut ops = ArithOps {
            product_start: start,
            ..ArithOps::default()
        };
        self.unary()?;
        while let Some(op) = self.arith_op() {
            self.unary()?;
            self.arith_push(&mut ops, op);
        }
        self.arith_finish(start, ops);
        Ok(())
    }

    /// `Unary <- '-' Unary / Postfix`, `Postfix <- Primary (…)*`
    fn unary(&mut self) -> PResult {
        let negs = self.prefixes(&Tok::Minus)?;
        match self.peek() {
            Tok::LParen => self.group()?,
            Tok::LBracket => {
                let n = self.list_items()?;
                self.make_list(n);
            }
            Tok::Ident(_) => self.ident()?,
            _ => self.literal()?,
        }
        self.postfix()?;
        self.wrap(negs, true);
        Ok(())
    }

    /// `'(' Or ')'`
    fn group(&mut self) -> PResult {
        self.enter()?;
        self.bump();
        self.or()?;
        self.expect(Tok::RParen, "')'")?;
        self.depth -= 1;
        Ok(())
    }

    /// `Call <- Ident '(' Args? ')'` or a variable.
    fn ident(&mut self) -> PResult {
        let (name, off) = self.name("an expression")?;
        if self.peek() != &Tok::LParen {
            return self.variable(&name, off);
        }
        let f = lookup_function(&name, off)?;
        let n = self.call_args()?;
        check_arity(f, &name, n, off)?;
        let args = self.pop_n(n);
        self.nodes.push(Node::Call(f, args));
        Ok(())
    }

    /// `( '.' Ident '(' Args? ')' / '.' Ident / '[' Or ']' )*` applied to the top node.
    fn postfix(&mut self) -> PResult {
        let mut ops = Vec::new();
        loop {
            match self.peek() {
                Tok::Dot => self.member(&mut ops)?,
                Tok::LBracket => {
                    self.enter()?;
                    self.bump();
                    self.or()?;
                    self.expect(Tok::RBracket, "']'")?;
                    self.depth -= 1;
                    let index = self.pop();
                    ops.push(PostOp::Index(index));
                }
                _ => break,
            }
        }
        self.make_postfix(ops);
        Ok(())
    }

    /// `'.' Ident '(' Args? ')'` (method: the receiver is the first argument) or `'.' Ident`.
    fn member(&mut self, ops: &mut Vec<PostOp>) -> PResult {
        self.bump();
        let (name, off) = self.name("a member name after '.'")?;
        if self.peek() != &Tok::LParen {
            ops.push(PostOp::Member(name));
            return Ok(());
        }
        let f = lookup_function(&name, off)?;
        let n = self.call_args()?;
        check_arity(f, &name, n + 1, off)?;
        let args = self.pop_n(n);
        ops.push(PostOp::Method(f, args));
        Ok(())
    }

    /// `'(' Args? ')'`, starting at `(`; pushes the arguments, returns their count.
    fn call_args(&mut self) -> PResult<usize> {
        self.enter()?;
        self.bump();
        let mut n = 0;
        if self.peek() == &Tok::RParen {
            self.bump();
        } else {
            loop {
                self.or()?;
                n += 1;
                if !self.separator(&Tok::RParen, "',' or ')'")? {
                    break;
                }
            }
        }
        self.depth -= 1;
        Ok(n)
    }

    /// `'[' ( Or ( ',' Or )* )? ']'`, starting at `[`; pushes the items, returns their count.
    fn list_items(&mut self) -> PResult<usize> {
        self.enter()?;
        self.bump();
        let mut n = 0;
        if self.peek() == &Tok::RBracket {
            self.bump();
        } else {
            loop {
                self.or()?;
                n += 1;
                if !self.separator(&Tok::RBracket, "',' or ']'")? {
                    break;
                }
            }
        }
        self.depth -= 1;
        Ok(n)
    }
}
