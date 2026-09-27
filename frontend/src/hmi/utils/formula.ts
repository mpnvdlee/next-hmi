/**
 * `$formula` expression language: numbers, `{n}` placeholders, `+ - * /`,
 * unary minus and parentheses. Parsed once per distinct expression string and
 * cached, since a formula is re-evaluated on every variable update it reads.
 *
 * The backend mirrors this grammar in `core/validation/structure.py` to flag
 * syntax errors in the warnings pill — keep the two in step.
 */

type FormulaNode =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; key: string }
  | { kind: 'neg'; operand: FormulaNode }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; key: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

const TOKEN_RE = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|\{\s*(\d+)\s*\}|([-+*/()]))/y;

function tokenize(expression: string): Token[] | null {
  const src = expression.trimEnd();
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src);
    if (!m) return null;
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: 'ref', key: String(Number(m[2])) });
    else tokens.push({ kind: 'op', value: m[3] as '+' | '-' | '*' | '/' | '(' | ')' });
  }
  return tokens;
}

function parse(tokens: Token[]): FormulaNode | null {
  let pos = 0;
  const isOp = (value: string) => {
    const t = tokens[pos];
    return t?.kind === 'op' && t.value === value;
  };

  function expr(): FormulaNode | null {
    let left = term();
    while (left && (isOp('+') || isOp('-'))) {
      const op = (tokens[pos++] as { value: '+' | '-' }).value;
      const right = term();
      if (!right) return null;
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  function term(): FormulaNode | null {
    let left = unary();
    while (left && (isOp('*') || isOp('/'))) {
      const op = (tokens[pos++] as { value: '*' | '/' }).value;
      const right = unary();
      if (!right) return null;
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  function unary(): FormulaNode | null {
    if (isOp('-')) {
      pos++;
      const operand = unary();
      return operand && { kind: 'neg', operand };
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return primary();
  }

  function primary(): FormulaNode | null {
    const t = tokens[pos];
    if (!t) return null;
    if (t.kind === 'num' || t.kind === 'ref') {
      pos++;
      return t;
    }
    if (t.value !== '(') return null;
    pos++;
    const inner = expr();
    if (!inner || !isOp(')')) return null;
    pos++;
    return inner;
  }

  const root = expr();
  return root && pos === tokens.length ? root : null;
}

const cache = new Map<string, FormulaNode | null>();
const CACHE_LIMIT = 500;

/** Parse `expression`, or `null` when it is empty or not valid syntax. */
export function parseFormula(expression: string): FormulaNode | null {
  const cached = cache.get(expression);
  if (cached !== undefined) return cached;
  const tokens = tokenize(expression);
  const node = tokens && tokens.length > 0 ? parse(tokens) : null;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(expression, node);
  return node;
}

/** The distinct placeholder numbers `expression` references, ascending. */
export function formulaWildcardKeys(expression: string): string[] {
  const keys = new Set<string>();
  for (const m of expression.matchAll(/\{\s*(\d+)\s*\}/g)) keys.add(String(Number(m[1])));
  return [...keys].sort((a, b) => Number(a) - Number(b));
}

/**
 * Evaluate a parsed formula. `lookup` returns a placeholder's numeric value,
 * or `null` when it has none. Any missing operand, a division by zero or a
 * non-finite result yields `null`, so no NaN or Infinity reaches a widget.
 */
export function evaluateFormula(
  node: FormulaNode,
  lookup: (key: string) => number | null,
): number | null {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ref':
      return lookup(node.key);
    case 'neg': {
      const v = evaluateFormula(node.operand, lookup);
      return v === null ? null : -v;
    }
    case 'bin': {
      const l = evaluateFormula(node.left, lookup);
      if (l === null) return null;
      const r = evaluateFormula(node.right, lookup);
      if (r === null) return null;
      let result: number;
      if (node.op === '+') result = l + r;
      else if (node.op === '-') result = l - r;
      else if (node.op === '*') result = l * r;
      else if (r === 0) return null;
      else result = l / r;
      return Number.isFinite(result) ? result : null;
    }
  }
}
