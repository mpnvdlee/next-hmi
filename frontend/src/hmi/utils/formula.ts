/**
 * `$formula` expression language, after IEC 61131-3 Structured Text: numbers
 * (`12`, `1.5`, `16#0C`, `2#1100`), `{n}` placeholders and one bit of one
 * (`{n}.3`), `+ - * /`, unary minus, parentheses, and on whole numbers
 * `AND OR XOR NOT`, `SHL(x, n)` and `SHR(x, n)`. Keywords take any case.
 * Precedence, tightest first: `NOT` and minus, `* /`, `+ -`, `AND`, `XOR`, `OR`.
 * Parsed once per distinct expression string and cached, since a formula is
 * re-evaluated on every variable update it reads.
 *
 * The backend mirrors this grammar in `core/validation/structure.py` to flag
 * syntax errors in the warnings pill — keep the two in step.
 */

type ArithOp = '+' | '-' | '*' | '/';
type BitOp = 'AND' | 'OR' | 'XOR' | 'SHL' | 'SHR';

type FormulaNode =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; key: string; bit?: number }
  | { kind: 'neg' | 'not'; operand: FormulaNode }
  | { kind: 'bin'; op: ArithOp | BitOp; left: FormulaNode; right: FormulaNode };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; key: string; bit?: number }
  | { kind: 'op'; value: string };

// Based literals before plain numbers (`16#…` starts with digits); a bit
// follows its placeholder with no space, so `{1} .3` stays an error.
const TOKEN_RE =
  /\s*(?:(16#[0-9a-f][0-9a-f_]*|2#[01][01_]*)|(\d+(?:\.\d*)?|\.\d+)|\{\s*(\d+)\s*\}(?:\.(\d+))?|(AND|OR|XOR|NOT|SHL|SHR)(?![a-z0-9_#])|([-+*/(),]))/iy;

function tokenize(expression: string): Token[] | null {
  const src = expression.trimEnd();
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src);
    if (!m) return null;
    if (m[1] !== undefined) {
      const [base, digits] = m[1].split('#');
      tokens.push({ kind: 'num', value: parseInt(digits.replace(/_/g, ''), Number(base)) });
    } else if (m[2] !== undefined) tokens.push({ kind: 'num', value: Number(m[2]) });
    else if (m[3] !== undefined) {
      const key = String(Number(m[3]));
      tokens.push(
        m[4] !== undefined ? { kind: 'ref', key, bit: Number(m[4]) } : { kind: 'ref', key },
      );
    } else tokens.push({ kind: 'op', value: (m[5] ?? m[6]).toUpperCase() });
  }
  return tokens;
}

function parse(tokens: Token[]): FormulaNode | null {
  let pos = 0;
  const isOp = (value: string) => {
    const t = tokens[pos];
    return t?.kind === 'op' && t.value === value;
  };
  const take = (value: string) => isOp(value) && ++pos > 0;

  /** One precedence level: `next (op next)*` for each op in `ops`. */
  const level =
    (ops: readonly (ArithOp | BitOp)[], next: () => FormulaNode | null) =>
    (): FormulaNode | null => {
      let left = next();
      while (left) {
        const op = ops.find((o) => isOp(o));
        if (!op) break;
        pos++;
        const right = next();
        if (!right) return null;
        left = { kind: 'bin', op, left, right };
      }
      return left;
    };

  function unary(): FormulaNode | null {
    if (take('-')) {
      const operand = unary();
      return operand && { kind: 'neg', operand };
    }
    if (take('NOT')) {
      const operand = unary();
      return operand && { kind: 'not', operand };
    }
    if (take('+')) return unary();
    return primary();
  }

  function primary(): FormulaNode | null {
    const t = tokens[pos];
    if (!t) return null;
    if (t.kind === 'num' || t.kind === 'ref') {
      pos++;
      return t;
    }
    if (t.value === 'SHL' || t.value === 'SHR') {
      pos++;
      if (!take('(')) return null;
      const left = expr();
      if (!left || !take(',')) return null;
      const right = expr();
      if (!right || !take(')')) return null;
      return { kind: 'bin', op: t.value, left, right };
    }
    if (!take('(')) return null;
    const inner = expr();
    return inner && take(')') ? inner : null;
  }

  const term = level(['*', '/'], unary);
  const sum = level(['+', '-'], term);
  const and = level(['AND'], sum);
  const xor = level(['XOR'], and);
  const expr = level(['OR'], xor);

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

/** A whole number as a BigInt, so bit operations reach past 32 bits; null for any other value. */
function whole(v: number | null): bigint | null {
  return v !== null && Number.isSafeInteger(v) ? BigInt(v) : null;
}

/** A BigInt result back as a number, or null beyond what a number holds exactly. */
function fromWhole(v: bigint): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Evaluate a parsed formula. `lookup` returns a placeholder's numeric value,
 * or `null` when it has none. Any missing operand, a division by zero, a
 * non-finite result, or a bit operation on a number that is not whole yields
 * `null`, so no NaN or Infinity reaches a widget.
 */
export function evaluateFormula(
  node: FormulaNode,
  lookup: (key: string) => number | null,
): number | null {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ref': {
      const v = lookup(node.key);
      if (node.bit === undefined) return v;
      const w = whole(v);
      return w === null ? null : Number((w >> BigInt(node.bit)) & 1n);
    }
    case 'neg': {
      const v = evaluateFormula(node.operand, lookup);
      return v === null ? null : -v;
    }
    case 'not': {
      const w = whole(evaluateFormula(node.operand, lookup));
      return w === null ? null : fromWhole(~w);
    }
    case 'bin': {
      const l = evaluateFormula(node.left, lookup);
      if (l === null) return null;
      const r = evaluateFormula(node.right, lookup);
      if (r === null) return null;
      if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/') {
        if (node.op === '/' && r === 0) return null;
        const result =
          node.op === '+' ? l + r : node.op === '-' ? l - r : node.op === '*' ? l * r : l / r;
        return Number.isFinite(result) ? result : null;
      }
      const a = whole(l);
      const b = whole(r);
      if (a === null || b === null) return null;
      if (node.op === 'AND') return fromWhole(a & b);
      if (node.op === 'OR') return fromWhole(a | b);
      if (node.op === 'XOR') return fromWhole(a ^ b);
      // A shift by a negative or huge count is no shift a PLC makes.
      if (b < 0n || b > 63n) return null;
      return fromWhole(node.op === 'SHL' ? a << b : a >> b);
    }
  }
}
