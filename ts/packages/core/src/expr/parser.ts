/**
 * Recursive-descent parser for spec/expr.peg (port of rust/crates/la-expr/src/parser.rs,
 * same productions and the same error order, offsets and messages).
 *
 * @module
 */

import type { ArithOp, CmpOp, FuncName, Node, PostOp, VarName } from "./ast.js";
import { FUNCTIONS, VARIABLES } from "./ast.js";
import { EXPR_ARITY, EXPR_SYNTAX, EXPR_UNKNOWN_IDENTIFIER, ExprError } from "./error.js";
import type { Token, TokKind } from "./lexer.js";
import { codePoints, describe, lex } from "./lexer.js";

/**
 * Maximum nesting depth: each ( … ) group, list literal, index [ … ], argument list and
 * each prefix ! / - opens one level; opening level 257 is an expr_syntax error.
 */
export const MAX_DEPTH = 256;

const CMP_OPS: { [k: string]: CmpOp } = { "==": "==", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
const ARITH_OPS: { [k: string]: ArithOp } = { "+": "+", "-": "-", "*": "*", "/": "/", "%": "%" };
const hasOwn = Object.prototype.hasOwnProperty;

function checkArity(f: FuncName, n: number, offset: number): void {
  const [count, variadic] = FUNCTIONS[f] as readonly [number, boolean];
  if ((variadic && n >= count) || (!variadic && n === count)) return;
  const plural = count === 1 ? "" : "s";
  const least = variadic ? "at least " : "";
  throw new ExprError(EXPR_ARITY, `${f}() takes ${least}${count} argument${plural}, got ${n}`, offset);
}

function lookupFunction(name: string, offset: number): FuncName {
  if (hasOwn.call(FUNCTIONS, name)) return name as FuncName;
  throw new ExprError(EXPR_UNKNOWN_IDENTIFIER, `unknown function '${name}'`, offset);
}

function andChain(ands: Node[], last: Node): Node {
  if (ands.length === 0) return last;
  return { k: "and", items: [...ands, last] };
}

function arithChain(first: Node, ops: ArithOp[], rest: Node[]): Node {
  return ops.length === 0 ? first : { k: "arith", first, ops, rest };
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly toks: Token[],
    private readonly lexError: ExprError | null,
  ) {}

  peek(): Token {
    return this.toks[this.pos] as Token;
  }

  private kind(): TokKind {
    return this.peek().kind;
  }

  private bump(): void {
    if (this.pos + 1 < this.toks.length) this.pos++;
  }

  /** The error for the current token (the lexer's error if the lexer stopped here). */
  unexpected(expected: string): ExprError {
    const t = this.peek();
    if (t.kind === "error" && this.lexError) return this.lexError;
    return new ExprError(EXPR_SYNTAX, `expected ${expected}, found ${describe(t)}`, t.offset);
  }

  private expect(kind: TokKind, what: string): void {
    if (this.kind() !== kind) throw this.unexpected(what);
    this.bump();
  }

  private enter(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new ExprError(EXPR_SYNTAX, `expression nested too deeply (more than ${MAX_DEPTH} levels)`, this.peek().offset);
    }
  }

  private prefixes(kind: TokKind): number {
    let n = 0;
    while (this.kind() === kind) {
      this.enter();
      this.bump();
      n++;
    }
    return n;
  }

  private wrap(node: Node, n: number, neg: boolean): Node {
    for (let i = 0; i < n; i++) {
      node = neg ? { k: "neg", e: node } : { k: "not", e: node };
      this.depth--;
    }
    return node;
  }

  /** Or <- And ('||' And)*, And <- Not ('&&' Not)* */
  or(): Node {
    const ors: Node[] = [];
    let ands: Node[] = [];
    let cur = this.not();
    for (;;) {
      const k = this.kind();
      if (k === "&&") {
        this.bump();
        ands.push(cur);
        cur = this.not();
      } else if (k === "||") {
        this.bump();
        ors.push(andChain(ands, cur));
        ands = [];
        cur = this.not();
      } else {
        break;
      }
    }
    const last = andChain(ands, cur);
    if (ors.length === 0) return last;
    ors.push(last);
    return { k: "or", items: ors };
  }

  /** Not <- '!' Not / Cmp, Cmp <- Add (CmpOp Add / 'in' List / 'not' 'in' List)? */
  private not(): Node {
    const nots = this.prefixes("!");
    const lhs = this.arith();
    let node: Node = lhs;
    const k = this.kind();
    if (hasOwn.call(CMP_OPS, k)) {
      this.bump();
      const rhs = this.arith();
      node = { k: "cmp", op: CMP_OPS[k] as CmpOp, l: lhs, r: rhs };
    } else if (k === "in" || k === "not") {
      const negate = k === "not";
      this.bump();
      if (negate) this.expect("in", "'in' after 'not'");
      if (this.kind() !== "[") throw this.unexpected("'[' after 'in'");
      const list = this.listItems();
      node = { k: "in", lhs, list, negate };
    }
    return this.wrap(node, nots, false);
  }

  /** Add <- Mul (('+' / '-') Mul)*, Mul <- Unary (('*' / '/' / '%') Unary)* */
  private arith(): Node {
    let firstTerm: Node | null = null;
    const termOps: ArithOp[] = [];
    const terms: Node[] = [];
    let addOp: ArithOp = "+";
    let product = this.unary();
    let mulOps: ArithOp[] = [];
    let factors: Node[] = [];
    for (;;) {
      const k = this.kind();
      if (!hasOwn.call(ARITH_OPS, k)) break;
      const op = ARITH_OPS[k] as ArithOp;
      this.bump();
      const operand = this.unary();
      if (op === "+" || op === "-") {
        const done = arithChain(product, mulOps, factors);
        mulOps = [];
        factors = [];
        if (firstTerm === null) {
          firstTerm = done;
        } else {
          termOps.push(addOp);
          terms.push(done);
        }
        addOp = op;
        product = operand;
      } else {
        mulOps.push(op);
        factors.push(operand);
      }
    }
    const done = arithChain(product, mulOps, factors);
    if (firstTerm === null) return done;
    termOps.push(addOp);
    terms.push(done);
    return { k: "arith", first: firstTerm, ops: termOps, rest: terms };
  }

  /** Unary <- '-' Unary / Postfix, Postfix <- Primary (…)* */
  private unary(): Node {
    const negs = this.prefixes("-");
    let node: Node;
    switch (this.kind()) {
      case "(":
        node = this.group();
        break;
      case "[":
        node = { k: "list", items: this.listItems() };
        break;
      case "ident":
        node = this.ident();
        break;
      default:
        node = this.literal();
    }
    node = this.postfix(node);
    return this.wrap(node, negs, true);
  }

  private literal(): Node {
    const t = this.peek();
    let node: Node;
    switch (t.kind) {
      case "num":
        node = { k: "num", v: t.num };
        break;
      case "str":
        node = { k: "str", v: t.text };
        break;
      case "true":
        node = { k: "bool", v: true };
        break;
      case "false":
        node = { k: "bool", v: false };
        break;
      case "null":
        node = { k: "null" };
        break;
      default:
        throw this.unexpected("an expression");
    }
    this.bump();
    return node;
  }

  /** '(' Or ')' */
  private group(): Node {
    this.enter();
    this.bump();
    const inner = this.or();
    this.expect(")", "')'");
    this.depth--;
    return inner;
  }

  /** Call <- Ident '(' Args? ')' or a variable. */
  private ident(): Node {
    const t = this.peek();
    const name = t.text;
    const off = t.offset;
    this.bump();
    if (this.kind() !== "(") {
      if (VARIABLES.has(name)) return { k: "var", v: name as VarName };
      throw new ExprError(EXPR_UNKNOWN_IDENTIFIER, `unknown identifier '${name}'`, off);
    }
    const f = lookupFunction(name, off);
    const args = this.callArgs();
    checkArity(f, args.length, off);
    return { k: "call", f, args };
  }

  /** ( '.' Ident '(' Args? ')' / '.' Ident / '[' Or ']' )* */
  private postfix(base: Node): Node {
    const ops: PostOp[] = [];
    for (;;) {
      const k = this.kind();
      if (k === ".") {
        ops.push(this.member());
      } else if (k === "[") {
        this.enter();
        this.bump();
        const index = this.or();
        this.expect("]", "']'");
        this.depth--;
        ops.push({ k: "index", index });
      } else {
        break;
      }
    }
    return ops.length === 0 ? base : { k: "postfix", base, ops };
  }

  /** '.' Ident '(' Args? ')' (method; the receiver is the first argument) or '.' Ident */
  private member(): PostOp {
    this.bump();
    const t = this.peek();
    if (t.kind !== "ident") throw this.unexpected("a member name after '.'");
    const name = t.text;
    const off = t.offset;
    this.bump();
    if (this.kind() !== "(") return { k: "member", name };
    const f = lookupFunction(name, off);
    const args = this.callArgs();
    checkArity(f, args.length + 1, off);
    return { k: "method", f, args };
  }

  /** '(' Args? ')' starting at '(' */
  private callArgs(): Node[] {
    this.enter();
    this.bump();
    const args: Node[] = [];
    if (this.kind() === ")") {
      this.bump();
    } else {
      for (;;) {
        args.push(this.or());
        if (!this.separator(")", "',' or ')'")) break;
      }
    }
    this.depth--;
    return args;
  }

  /** '[' ( Or ( ',' Or )* )? ']' starting at '[' */
  private listItems(): Node[] {
    this.enter();
    this.bump();
    const items: Node[] = [];
    if (this.kind() === "]") {
      this.bump();
    } else {
      for (;;) {
        items.push(this.or());
        if (!this.separator("]", "',' or ']'")) break;
      }
    }
    this.depth--;
    return items;
  }

  private separator(close: TokKind, what: string): boolean {
    const k = this.kind();
    if (k === ",") {
      this.bump();
      return true;
    }
    if (k === close) {
      this.bump();
      return false;
    }
    throw this.unexpected(what);
  }
}

/** Parses `src` into a syntax tree; throws ExprError. */
export function parseNode(src: string): Node {
  const lexed = lex(codePoints(src));
  const p = new Parser(lexed.tokens, lexed.error);
  const node = p.or();
  if (p.peek().kind !== "eof") throw p.unexpected("end of input");
  return node;
}
