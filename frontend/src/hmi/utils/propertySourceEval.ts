import { isRecord } from '@shared/types/propertyValueGuards';
import type { AlarmCountFilter } from '@shared/types/alarm';
import type { RecipeField, RecipeRow } from '@shared/types/recipe';
import type { PageField, PagePathSegment } from '@shared/types/config';
import type { HttpEntry, HttpRequestSpec } from '../store/httpSourceStore';
import { imageBodyToUrl } from '@shared/utils/imageAsset';
import { withBase } from '@shared/utils/runtimeBase';
import { resolveComponentPropKey } from './componentPropResolution';
import { toNumber } from './coercion';

/**
 * Evaluates `$`-prefixed property sources. The dispatch table at
 * `SOURCE_HANDLERS` enumerates every supported key; unknown sources resolve
 * to `null` with a dev-mode warning.
 */

export type ResolvedValue = string | number | boolean | null | undefined;

export interface EvaluationContext {
  resolveVariable?: (datasource: string, path: string) => ResolvedValue;
  resolveTranslation?: (key: string) => string;
  getUrlParam?: (name: string) => string | undefined;
  isPageActive?: (pageId: string) => boolean;
  /** Page id of the renderer scope (page route, overlay, page-group child).
   *  Used as the fallback target for `$pageIsActive` when no `page` is set. */
  hostPageId?: string;
  resolveUser?: (field: 'username' | 'groups') => string | null;
  /** Raw group ids of the signed-in user, for `$userGroups` membership tests. */
  resolveUserGroups?: () => string[];
  /** Every username in the project, for `$user` with `field: 'userList'`. Read
   *  on the record-list path only — the scalar path cannot carry an array. */
  resolveUserList?: () => string[];
  resolveDevice?: (field: 'hostname' | 'ipAddress' | 'macAddress') => string | null;
  resolveTime?: (format?: string, timezone?: string) => string | null;
  resolveComponentProp?: (componentId: string, property: string) => ResolvedValue;
  resolveAlarmCount?: (filter: AlarmCountFilter) => number;
  resolveRecipe?: (typeId: string, field: RecipeField) => string | boolean;
  /** Resolve the $recipeList property source: the datasets of a type as grid rows.
   *  Returns an array (not an ResolvedValue), so it is read via
   *  `useRecordListProp`, not the scalar `evaluatePropertyValue` path. */
  resolveRecipeList?: (typeId: string) => RecipeRow[];
  /**
   * Read page metadata. Returns scalar fields directly; for `pathString` the
   * separator is honoured; for `pathSegments` the consumer can also use
   * `resolvePagePath` to get the structured array.
   */
  resolvePage?: (field: PageField, pageId?: string, separator?: string) => ResolvedValue;
  /** Returns the structured ancestor path of the current (or given) page. */
  resolvePagePath?: (pageId?: string) => PagePathSegment[];
  resolveViewport?: (field: 'size' | 'width' | 'height' | 'orientation') => ResolvedValue;
  /**
   * Read the cached response for an `$http` request, priming the fetch on first
   * call. Returns `undefined` until the first response lands — evaluation is
   * synchronous, so the value arrives on a later render (widgets subscribe via
   * `useHttpTick`).
   */
  resolveHttpRequest?: (spec: HttpRequestSpec) => HttpEntry | undefined;
  /**
   * Innermost input scope (widget/dialog) at the read site. Drives `$componentProp`
   * resolution: top-level references in component property
   * bags are pre-resolved by `useResolvedProperties`; this is what catches
   * references nested inside other sources and inside action payloads.
   */
  inputScopeProps?: Record<string, unknown>;
  /**
   * Backend response payload made available to onSuccess / onFailed / onSettled
   * handlers via `{ $result: 'field' }`. Set by `actionDispatcher` when
   * invoking handler arrays; missing in all other evaluation contexts (the
   * `$result` source resolves to `null` then).
   */
  resultValue?: Record<string, unknown>;
}

const MAX_SOURCE_RECURSION_DEPTH = 64;

/**
 * Dispatcher: maps property-source key → evaluator function.
 * Each handler receives (payload, context, depth) and returns ResolvedValue.
 * Adding a new property source means adding one entry here.
 */
type SourceHandler = (payload: unknown, context: EvaluationContext, depth: number) => ResolvedValue;

const SOURCE_HANDLERS: Record<string, SourceHandler> = {
  $static: (payload) => resolveStaticValue(payload),
  $var: (payload, ctx) => evaluateVar(payload, ctx),
  $loc: (payload, ctx) => evaluateLoc(payload, ctx),
  $urlParam: (payload, ctx) => evaluateUrlParam(payload, ctx),
  $pageIsActive: (payload, ctx) => evaluatePageIsActive(payload, ctx),
  $if: (payload, ctx, d) => evaluateIf(payload, ctx, d),
  $compare: (payload, ctx, d) => evaluateCompare(payload, ctx, d),
  $random: (payload) => evaluateRandom(payload),
  $switch: (payload, ctx, d) => evaluateSwitch(payload, ctx, d),
  $user: (payload, ctx) => evaluateUser(payload, ctx),
  $userGroups: (payload, ctx) => evaluateUserGroups(payload, ctx),
  $device: (payload, ctx) => evaluateDevice(payload, ctx),
  $time: (payload, ctx) => evaluateTime(payload, ctx),
  $widgetProp: (payload, ctx) => evaluateWidgetProp(payload, ctx),
  $componentProp: (payload, ctx, depth) => evaluateComponentProp(payload, ctx, depth),
  $result: (payload, ctx) => evaluateResult(payload, ctx),
  $stringExpr: (payload, ctx, d) => evaluateStringExpr(payload, ctx, d),
  $http: (payload, ctx, d) => evaluateHttp(payload, ctx, d),
  $alarmCount: (payload, ctx) => evaluateAlarmCount(payload, ctx),
  $recipe: (payload, ctx) => evaluateRecipe(payload, ctx),
  $page: (payload, ctx) => evaluatePage(payload, ctx),
  $viewport: (payload, ctx) => evaluateViewport(payload, ctx),
};

/**
 * Main evaluation function.
 * Takes a value (plain or sourced) and evaluates it in the given context.
 * Returns the evaluated value.
 */
export function evaluatePropertyValue(
  value: unknown,
  context: EvaluationContext = {},
): ResolvedValue {
  return evaluatePropertyValueInternal(value, context, MAX_SOURCE_RECURSION_DEPTH);
}

function evaluatePropertyValueInternal(
  value: unknown,
  context: EvaluationContext,
  depth: number,
): ResolvedValue {
  if (depth <= 0) {
    return null;
  }

  // Plain values
  if (value === null || value === undefined) {
    return value;
  }

  if (!isRecord(value)) {
    return value as ResolvedValue;
  }

  const obj = value;

  // Find the first $-prefixed key — that is the property-source discriminant.
  const sourceKey = Object.keys(obj).find((k) => k.startsWith('$'));

  if (!sourceKey) {
    // Plain object with no source key: not a sourced value, pass through as undefined.
    return undefined;
  }

  const handler = SOURCE_HANDLERS[sourceKey];
  if (handler) {
    return handler(obj[sourceKey], context, depth - 1);
  }

  // Unknown $-prefixed key: tolerate and return null.
  if (import.meta.env.DEV) {
    console.warn(`[propertySourceEval] Unknown property-source key: "${sourceKey}"`);
  }
  return null;
}

/**
 * Looks up `payload` against `context.inputScopeProps` (published by the
 * surrounding widget/dialog) and recursively evaluates the result, so a `$var`
 * parent or a `key/sub/path` extension resolves to a live value.
 */
function evaluateComponentProp(
  payload: unknown,
  context: EvaluationContext,
  depth: number,
): ResolvedValue {
  if (typeof payload !== 'string' || !context.inputScopeProps) return null;
  const resolved = resolveComponentPropKey(payload, context.inputScopeProps);
  if (resolved === undefined) return null;
  return evaluatePropertyValueInternal(resolved, context, depth);
}

/**
 * Reads a field off `context.resultValue` — only populated when the value
 * evaluates inside an async action's onSuccess / onFailed / onSettled handler.
 * Outside that context, or for an unknown field, resolves to `null` (same
 * missing-value convention as the other sources).
 */
function evaluateResult(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof payload !== 'string' || !context.resultValue) return null;
  const v = context.resultValue[payload];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  // Non-scalar payload fields (e.g. groups: string[]) — surface as a JSON string
  // so authors can at least display them via $loc / showToast without bespoke
  // accessors. Callers needing structured access should pre-flatten on the
  // backend.
  return JSON.stringify(v);
}

function evaluateVar(varObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof varObj !== 'object' || varObj === null) {
    return null;
  }

  const v = varObj as Record<string, unknown>;
  const composite = v.path as string | undefined;
  const index = typeof v.index === 'number' ? v.index : undefined;

  if (!composite || !context.resolveVariable) {
    return null;
  }

  const colon = composite.indexOf(':');
  if (colon < 0) {
    return null;
  }
  const datasource = composite.slice(0, colon);
  const path = composite.slice(colon + 1);
  if (!datasource || !path) {
    return null;
  }

  const value = context.resolveVariable(datasource, path);

  if (index !== undefined && Array.isArray(value)) {
    return (value[index] ?? null) as ResolvedValue;
  }

  return value;
}

function evaluateLoc(locObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof locObj !== 'string') {
    return null;
  }

  if (!context.resolveTranslation) {
    return locObj; // Return key as fallback
  }

  return context.resolveTranslation(locObj);
}

function evaluateUrlParam(paramObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof paramObj !== 'object' || paramObj === null) {
    return null;
  }

  const p = paramObj as Record<string, unknown>;
  const name = p.name as string | undefined;
  const defaultValue = p.default as ResolvedValue | undefined;

  if (!name || !context.getUrlParam) {
    return defaultValue ?? null;
  }

  const value = context.getUrlParam(name);
  return value ?? defaultValue ?? null;
}

function evaluatePageIsActive(pageObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof pageObj !== 'object' || pageObj === null || !context.isPageActive) {
    return false;
  }

  const p = pageObj as Record<string, unknown>;
  const explicit = (p.page as string | undefined) || undefined;
  const targetId = explicit ?? context.hostPageId;

  if (!targetId) {
    return false;
  }

  return context.isPageActive(targetId);
}

function evaluateIf(ifObj: unknown, context: EvaluationContext, depth: number): ResolvedValue {
  if (typeof ifObj !== 'object' || ifObj === null) {
    return null;
  }

  const i = ifObj as Record<string, unknown>;
  const condition = i.condition;
  const trueValue = i.true;
  const falseValue = i.false;

  // Evaluate condition and coerce to boolean
  const condResult = evaluatePropertyValueInternal(condition, context, depth);
  return evaluatePropertyValueInternal(condResult ? trueValue : falseValue, context, depth);
}

/**
 * Strict equality with numeric coercion when exactly one operand is a number
 * and the other a parseable numeric string. Same-typed values fall through to
 * `===`, so `"5" === "05"` stays false and `0 === false` stays false.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') {
    const n = parseFloat(b);
    return !isNaN(n) && a === n;
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const n = parseFloat(a);
    return !isNaN(n) && b === n;
  }
  return false;
}

function evaluateCompare(
  cmpObj: unknown,
  context: EvaluationContext,
  depth: number,
): ResolvedValue {
  if (typeof cmpObj !== 'object' || cmpObj === null) {
    return false;
  }

  const c = cmpObj as Record<string, unknown>;
  const left = evaluatePropertyValueInternal(c.left, context, depth);
  const operator = c.operator as string | undefined;
  const right = evaluatePropertyValueInternal(c.right, context, depth);

  if (!operator) {
    return false;
  }

  const leftNum = toNumber(left);
  const rightNum = toNumber(right);

  switch (operator) {
    case '>':
      return (leftNum ?? 0) > (rightNum ?? 0);
    case '<':
      return (leftNum ?? 0) < (rightNum ?? 0);
    case '>=':
      return (leftNum ?? 0) >= (rightNum ?? 0);
    case '<=':
      return (leftNum ?? 0) <= (rightNum ?? 0);
    case '===':
      return looseEquals(left, right);
    case '!==':
      return !looseEquals(left, right);
    default:
      return false;
  }
}

function evaluateRandom(randObj: unknown): ResolvedValue {
  if (typeof randObj !== 'object' || randObj === null) {
    return null;
  }

  const r = randObj as Record<string, unknown>;
  const min = toNumber(r.min) ?? 0;
  const max = toNumber(r.max) ?? 100;
  const integer = r.integer !== false; // default true

  // Ensure min <= max
  const actualMin = Math.min(min, max);
  const actualMax = Math.max(min, max);

  const value = Math.random() * (actualMax - actualMin) + actualMin;

  return integer ? Math.round(value) : value;
}

function evaluateSwitch(
  switchObj: unknown,
  context: EvaluationContext,
  depth: number,
): ResolvedValue {
  if (typeof switchObj !== 'object' || switchObj === null) {
    return null;
  }

  const s = switchObj as Record<string, unknown>;
  const switchValue = evaluatePropertyValueInternal(s.value, context, depth);
  const cases = (s.cases ?? []) as Array<Record<string, unknown>>;
  const defaultValue = s.default;

  // Find matching case (numeric coercion: 5 matches "5")
  for (const c of cases) {
    const caseValue = evaluatePropertyValueInternal(c.when, context, depth);
    if (looseEquals(caseValue, switchValue)) {
      return evaluatePropertyValueInternal(c.then, context, depth);
    }
  }

  // No match — return default
  return evaluatePropertyValueInternal(defaultValue, context, depth);
}

function evaluateWidgetProp(propObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof propObj !== 'object' || propObj === null || !context.resolveComponentProp) {
    return null;
  }
  const p = propObj as Record<string, unknown>;
  const componentId = typeof p.componentId === 'string' ? p.componentId : '';
  const property = typeof p.property === 'string' ? p.property : '';
  if (!componentId || !property) return null;
  const base = context.resolveComponentProp(componentId, property);
  const path = typeof p.path === 'string' ? p.path : '';
  return path ? (drillValuePath(base, path) as ResolvedValue) : base;
}

/**
 * Walk a slash-path into a resolved value (plain object / array). Used to bind
 * an individual field of a struct `$widgetProp` export (e.g. the `name` of a
 * selected row) and to pick a field out of an `$http` JSON response. Numeric
 * segments index arrays; missing segments resolve to null so a stale path
 * degrades gracefully instead of throwing.
 */
function drillValuePath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('/')) {
    if (seg === '') continue;
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return cur ?? null;
}

function evaluateUser(userObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof userObj !== 'object' || userObj === null) {
    return null;
  }

  const u = userObj as Record<string, unknown>;
  const field = u.field as 'username' | 'groups' | 'userList' | undefined;

  // `userList` is an array source and `ResolvedValue` is scalar-only, so it is
  // resolved on the record-list path (`resolveRecordListSource`) instead. Join
  // here rather than returning null: a user who binds it to a text field should
  // see the names, not a silently empty field.
  if (field === 'userList') {
    const names = context.resolveUserList?.() ?? [];
    return names.length ? names.join(', ') : null;
  }

  if (field !== 'username' && field !== 'groups') {
    return null;
  }

  return context.resolveUser?.(field) ?? null;
}

function evaluateUserGroups(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof payload !== 'object' || payload === null) return true;
  const selected = (payload as Record<string, unknown>).groups;
  if (!Array.isArray(selected) || selected.length === 0) return true;
  const userGroups = context.resolveUserGroups?.() ?? [];
  return userGroups.some((g) => (selected as string[]).includes(g));
}

function evaluateDevice(deviceObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof deviceObj !== 'object' || deviceObj === null || !context.resolveDevice) {
    return null;
  }

  const d = deviceObj as Record<string, unknown>;
  const field = d.field;

  if (field !== 'hostname' && field !== 'ipAddress' && field !== 'macAddress') {
    return null;
  }

  return context.resolveDevice(field);
}

function evaluateTime(timeObj: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof timeObj !== 'object' || timeObj === null) {
    return null;
  }

  const t = timeObj as Record<string, unknown>;
  const format = typeof t.format === 'string' && t.format.trim() ? t.format : 'HH:mm:ss';
  const timezone = typeof t.timezone === 'string' && t.timezone.trim() ? t.timezone : undefined;

  if (context.resolveTime) {
    return context.resolveTime(format, timezone);
  }

  return formatDateByPattern(new Date(), format, timezone);
}

// ── String Expression ────────────────────────────────────────────────────────

/** Regex that matches a full `{…}` placeholder block in a template string.
 *  Braces are excluded from the body so an `$http` request whose JSON body is
 *  itself brace-wrapped (`{"id": "{1}"}`) still matches the inner placeholder.
 *  Mirrors `_WILDCARD_RE` in `backend/core/validation/structure.py`. */
const PLACEHOLDER_RE = /\{([^{}]+)\}/g;

/**
 * Parse a placeholder body like `Trim(ToLower(1))` into a list of functions
 * (outer-first) and the inner wildcard number string.
 *
 * Returns `{ fns: ['Trim', 'ToLower'], key: '1' }` for `Trim(ToLower(1))`.
 * For a plain `1`, returns `{ fns: [], key: '1' }`.
 */
function parsePlaceholder(body: string): { fns: string[]; key: string } | null {
  const fns: string[] = [];
  let rest = body.trim();

  // Peel off function wrappers: FnName(…)
  while (true) {
    const m = /^([A-Za-z]\w*)\((.+)\)$/.exec(rest);
    if (!m) break;
    fns.push(m[1]);
    rest = m[2].trim();
  }

  // What remains must be a positive integer (wildcard key)
  if (!/^\d+$/.test(rest)) return null;
  return { fns, key: rest };
}

/** Supported transform functions mapped to their implementations. */
const STRING_EXPR_FNS: Record<string, (v: string) => string> = {
  ToLower: (v) => v.toLowerCase(),
  ToUpper: (v) => v.toUpperCase(),
  Trim: (v) => v.trim(),
  Capitalize: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(),
  Round: (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? v : String(Math.round(n));
  },
  Round1: (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? v : n.toFixed(1);
  },
  Round2: (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? v : n.toFixed(2);
  },
  // Digit grouping for readable counters ("41280" → "41,280"). Locale-independent
  // on purpose: an operator screen shows the same separator wherever it runs.
  Thousands: (v) => {
    const n = parseFloat(v);
    if (isNaN(n)) return v;
    const [int, frac] = String(n).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac}` : grouped;
  },
};

/**
 * Fill `{1}` / `{Trim(ToLower(2))}` placeholders in `template` from `wildcards`,
 * evaluating each wildcard as a full property value. Shared by `$stringExpr`
 * and by `$http`, whose url / body / header values use the same syntax.
 */
function renderTemplate(
  template: string,
  wildcards: Record<string, unknown>,
  context: EvaluationContext,
  depth: number,
): string {
  if (!template) return '';

  return template.replace(PLACEHOLDER_RE, (_match, body: string) => {
    const parsed = parsePlaceholder(body);
    if (!parsed) return `{${body}}`; // leave unrecognised placeholders intact

    const wcValue = wildcards[parsed.key];
    if (wcValue === undefined) return `{${body}}`;

    // Resolve wildcard using the standard expression evaluator
    const evaluated = evaluatePropertyValueInternal(wcValue, context, depth);
    let resolved = evaluated != null ? String(evaluated) : '';

    // Apply transform functions inside-out (the fns array is outer-first)
    for (let i = parsed.fns.length - 1; i >= 0; i--) {
      const fn = STRING_EXPR_FNS[parsed.fns[i]];
      if (fn) resolved = fn(resolved);
    }

    return resolved;
  });
}

function wildcardsOf(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.wildcards) ? payload.wildcards : {};
}

function evaluateStringExpr(
  exprObj: unknown,
  context: EvaluationContext,
  depth: number,
): ResolvedValue {
  if (!isRecord(exprObj)) return null;
  const template = typeof exprObj.template === 'string' ? exprObj.template : '';
  if (!template) return '';
  return renderTemplate(template, wildcardsOf(exprObj), context, depth);
}

// ── HTTP Request ─────────────────────────────────────────────────────────────

/**
 * Resolve an `$http` source: template the request, hand it to the cache, and
 * pick `path` out of whatever response is cached right now. Returns `null`
 * while the first request is still in flight and whenever the extraction path
 * misses, so the field falls back exactly as it would for any absent source.
 */
function evaluateHttp(payload: unknown, context: EvaluationContext, depth: number): ResolvedValue {
  if (!isRecord(payload) || !context.resolveHttpRequest) return null;

  const wildcards = wildcardsOf(payload);
  const url = renderTemplate(
    typeof payload.url === 'string' ? payload.url : '',
    wildcards,
    context,
    depth,
  ).trim();
  if (!url) return null;

  const method = payload.method === 'POST' ? 'POST' : 'GET';

  const headers: Record<string, string> = {};
  if (Array.isArray(payload.headers)) {
    for (const h of payload.headers) {
      if (!isRecord(h)) continue;
      const name = typeof h.name === 'string' ? h.name.trim() : '';
      if (!name) continue;
      headers[name] = renderTemplate(
        typeof h.value === 'string' ? h.value : '',
        wildcards,
        context,
        depth,
      );
    }
  }

  const bodyTemplate = typeof payload.body === 'string' ? payload.body : '';
  const body =
    method === 'POST' && bodyTemplate
      ? renderTemplate(bodyTemplate, wildcards, context, depth)
      : undefined;

  const refreshSeconds = toNumber(payload.refreshSeconds) ?? 0;

  const entry = context.resolveHttpRequest({
    url,
    method,
    headers,
    body,
    refreshMs: refreshSeconds > 0 ? refreshSeconds * 1000 : 0,
  });

  if (!entry || entry.data === undefined) return null;

  const path = typeof payload.path === 'string' ? payload.path.trim() : '';
  return toScalar(path ? drillValuePath(entry.data, path) : entry.data);
}

/**
 * Collapse a decoded JSON value to the scalar channel property values travel
 * on. Objects and arrays are surfaced as JSON text rather than dropped, so an
 * author who binds a whole sub-object still sees it (the same convention
 * `$result` uses for its non-scalar fields).
 */
function toScalar(value: unknown): ResolvedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a `$static` payload. Primitives pass through unchanged. Structured
 * `icon` (`{ type, name | path }`) and `image` (`{ path }`) payloads — used by
 * `icon`/`image`-typed fields — resolve to the renderable string (a builtin
 * icon name, or an asset URL).
 */
function resolveStaticValue(payload: unknown): ResolvedValue {
  if (isRecord(payload)) {
    if (payload.type === 'builtin' || payload.type === 'custom') {
      return resolveIconValue(payload);
    }
    if (typeof payload.path === 'string') {
      return imageBodyToUrl(payload);
    }
    return null;
  }
  return payload as ResolvedValue;
}

function resolveIconValue(iconObj: unknown): ResolvedValue {
  if (typeof iconObj !== 'object' || iconObj === null) {
    return null;
  }
  const i = iconObj as Record<string, unknown>;
  if (i.type === 'builtin') {
    return typeof i.name === 'string' && i.name ? i.name : null;
  }
  if (i.type === 'custom') {
    if (typeof i.path !== 'string' || !i.path) {
      return null;
    }
    return withBase(i.path.startsWith('icons/') ? `/assets/${i.path}` : `/assets/icons/${i.path}`);
  }
  return null;
}

const PAGE_FIELDS: ReadonlySet<PageField> = new Set([
  'id',
  'title',
  'icon',
  'description',
  'breadcrumbLabel',
  'depth',
  'parentId',
  'pathString',
  'pathSegments',
]);

function evaluatePage(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (!isRecord(payload)) return null;
  const field = payload.field;
  if (typeof field !== 'string' || !PAGE_FIELDS.has(field as PageField)) return null;
  const pageId = typeof payload.pageId === 'string' ? payload.pageId : undefined;
  const separator = typeof payload.separator === 'string' ? payload.separator : undefined;
  if (!context.resolvePage) return null;
  return context.resolvePage(field as PageField, pageId, separator);
}

function evaluateViewport(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (!isRecord(payload)) return null;
  const field = payload.field;
  if (field !== 'size' && field !== 'width' && field !== 'height' && field !== 'orientation') {
    return null;
  }
  if (!context.resolveViewport) return null;
  return context.resolveViewport(field);
}

function evaluateAlarmCount(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof payload !== 'object' || payload === null) return 0;
  const filter = (payload as Record<string, unknown>).filter;
  if (typeof filter !== 'string') return 0;
  return context.resolveAlarmCount?.(filter as AlarmCountFilter) ?? 0;
}

function evaluateRecipe(payload: unknown, context: EvaluationContext): ResolvedValue {
  if (typeof payload !== 'object' || payload === null) return false;
  const { type, field } = payload as Record<string, unknown>;
  if (typeof type !== 'string' || typeof field !== 'string') return false;
  return (
    context.resolveRecipe?.(type, field as RecipeField) ?? (field === 'activeName' ? '' : false)
  );
}

function formatDateByPattern(date: Date, format: string, timezone?: string): string {
  if (format === 'ISO') {
    return date.toISOString();
  }

  const parts = getDateParts(date, timezone);
  return format
    .replace(/YYYY/g, parts.year)
    .replace(/MM/g, parts.month)
    .replace(/DD/g, parts.day)
    .replace(/HH/g, parts.hour)
    .replace(/mm/g, parts.minute)
    .replace(/ss/g, parts.second);
}

function getDateParts(
  date: Date,
  timezone?: string,
): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const tokenMap = new Map<string, string>();
    for (const p of formatter.formatToParts(date)) {
      tokenMap.set(p.type, p.value);
    }
    return {
      year: tokenMap.get('year') ?? '0000',
      month: tokenMap.get('month') ?? '01',
      day: tokenMap.get('day') ?? '01',
      hour: tokenMap.get('hour') ?? '00',
      minute: tokenMap.get('minute') ?? '00',
      second: tokenMap.get('second') ?? '00',
    };
  } catch {
    const fallback = new Date(date.getTime());
    return {
      year: String(fallback.getFullYear()),
      month: String(fallback.getMonth() + 1).padStart(2, '0'),
      day: String(fallback.getDate()).padStart(2, '0'),
      hour: String(fallback.getHours()).padStart(2, '0'),
      minute: String(fallback.getMinutes()).padStart(2, '0'),
      second: String(fallback.getSeconds()).padStart(2, '0'),
    };
  }
}
