/**
 * Shared helpers for surfacing "this value comes from the theme" in the editor.
 *
 * A property left unset falls back to a `var(--hmi-*)` token; these helpers let
 * the color picker and layout fields show that an untouched value is themed and
 * *which* token supplies it, with the same presentation everywhere.
 */
import { useMemo } from 'react';
import { THEME_TOKENS } from './themeTokens';

/** Theme color tokens, for the ColorInput "Theme" tab. */
export const THEME_COLOR_TOKENS = THEME_TOKENS.filter((t) => t.section === 'colors').map((t) => ({
  cssVar: t.cssVar,
  label: t.label,
}));

const LABEL_BY_VAR: Record<string, string> = Object.fromEntries(
  THEME_TOKENS.map((t) => [t.cssVar, t.label]),
);

/** Wrap a css var name as a CSS reference, e.g. `--hmi-accent` → `var(--hmi-accent)`. */
export function tokenVar(cssVar: string): string {
  return `var(${cssVar})`;
}

/** If *value* is a `var(--hmi-*)` reference, return the bare css var; else null. */
export function parseTokenVar(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  return m ? m[1] : null;
}

/** Human label for a token css var (e.g. `--hmi-accent` → `Accent`). */
export function tokenLabel(cssVar: string): string {
  return LABEL_BY_VAR[cssVar] ?? cssVar.replace(/^--hmi-/, '');
}

/** Resolve a token's concrete value from the document root (e.g. `#0a84ff`, `0.5rem`). */
export function resolveTokenValue(cssVar: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
}

/**
 * Resolve several token values in a single `getComputedStyle` read. Prefer this
 * over calling {@link resolveTokenValue} in a loop — `getComputedStyle` forces a
 * style recalc, so one call per render beats one per token.
 */
export function resolveTokenValues(cssVars: string[]): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const cssVar of cssVars) out[cssVar] = style.getPropertyValue(cssVar).trim();
  return out;
}

/**
 * Panel-level version of {@link resolveTokenValues}: resolves every token a
 * properties panel's fields might fall back to in one `getComputedStyle` read
 * per render, instead of each field (unset-hint, layout placeholder, …)
 * reading the style sheet on its own. Pass `undefined`/duplicate entries
 * freely — they're deduped before the read.
 */
export function usePanelTokenValues(
  cssVars: (string | null | undefined)[],
): Record<string, string> {
  const unique = Array.from(new Set(cssVars.filter((v): v is string => Boolean(v)))).sort();
  const key = unique.join('|');
  // `key` fully determines `unique`'s contents; re-deriving it per render is fine, we only
  // want to skip the getComputedStyle read itself when the token set hasn't changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => resolveTokenValues(unique), [key]);
}
