import type { ThemeConfig, ThemesIndex } from '@shared/types/theme';
import { apiJson } from './api';
import themeDefaults from '../themeDefaults.json';

/**
 * Single source of truth for all editable theme tokens.
 *
 * - Default values come from `frontend/src/shared/themeDefaults.json` —
 *   the same JSON the backend Pydantic models read.
 * - Each entry carries the UI metadata the Theme Editor needs (input type,
 *   group, placeholder, etc.) so the editor can derive its sections from
 *   this list rather than maintaining a parallel `SECTIONS` constant.
 *
 * To add a token: append one entry here, add the matching field to
 * `themeDefaults.json` and the matching Pydantic field on the backend.
 */

export type ThemeSection = 'colors' | 'typography' | 'spacing';
type ThemeInputType = 'color' | 'text' | 'number' | 'font' | 'select';

interface ThemeSelectOption {
  label: string;
  value: string;
}

export interface ThemeTokenEntry {
  /** CSS custom property name, e.g. `--hmi-bg`. */
  cssVar: string;
  /** Dot-path into ThemeConfig, e.g. `colors.bg`. */
  themePath: string;
  /** Theme section this token belongs to. */
  section: ThemeSection;
  /** Editor input type. */
  inputType: ThemeInputType;
  /** Options for `inputType: 'select'`. */
  options?: ThemeSelectOption[];
  /** Optional sub-group label (used inside the spacing section). */
  group?: string;
  /** Render the input full-width in the editor grid. */
  wide?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Human-readable label for editor UI. */
  label: string;
}

/** localStorage keys for cross-tab theme communication. */
export const LS_THEME_PREVIEW = 'hmi_theme_preview';
export const LS_THEME_SAVED = 'hmi_theme_saved';

/**
 * Drop the unsaved-theme preview payload.
 *
 * The payload only describes what the Themes view is previewing *right now*,
 * and its drafts live in memory — they die with the document that wrote them.
 * Left in localStorage it outlives that session and pins the editor's preview
 * iframe (which prefers it over the API on mount) to a stale theme forever, so
 * every config document clears it before any view can mount that iframe.
 */
export function clearThemePreview(): void {
  try {
    localStorage.removeItem(LS_THEME_PREVIEW);
  } catch {
    // Best-effort; a blocked localStorage means nothing was persisted anyway.
  }
}

// ── Token definitions ─────────────────────────────────────────────────────────

const TEXT_TRANSFORM_OPTIONS: ThemeSelectOption[] = [
  { label: 'None', value: 'none' },
  { label: 'UPPERCASE', value: 'uppercase' },
  { label: 'lowercase', value: 'lowercase' },
  { label: 'Capitalize', value: 'capitalize' },
];

/**
 * Build the five token entries (font / size / weight / tracking / transform)
 * for one typography combo. The combo's CSS vars are
 * `--hmi-type-<key>-{font,size,weight,tracking,transform}` and the fields are
 * grouped under *label* in the editor.
 */
function typographyCombo(key: string, label: string): ThemeTokenEntry[] {
  return [
    {
      cssVar: `--hmi-type-${key}-font`,
      themePath: `typography.${key}_font`,
      section: 'typography',
      inputType: 'font',
      wide: true,
      group: label,
      label: 'Font',
    },
    {
      cssVar: `--hmi-type-${key}-size`,
      themePath: `typography.${key}_size`,
      section: 'typography',
      inputType: 'text',
      group: label,
      placeholder: 'e.g. 1rem',
      label: 'Size',
    },
    {
      cssVar: `--hmi-type-${key}-weight`,
      themePath: `typography.${key}_weight`,
      section: 'typography',
      inputType: 'number',
      min: 100,
      max: 900,
      step: 100,
      group: label,
      label: 'Weight',
    },
    {
      cssVar: `--hmi-type-${key}-tracking`,
      themePath: `typography.${key}_tracking`,
      section: 'typography',
      inputType: 'text',
      group: label,
      placeholder: 'e.g. 0.05em',
      label: 'Letter spacing',
    },
    {
      cssVar: `--hmi-type-${key}-transform`,
      themePath: `typography.${key}_transform`,
      section: 'typography',
      inputType: 'select',
      options: TEXT_TRANSFORM_OPTIONS,
      group: label,
      label: 'Case',
    },
  ];
}

export const THEME_TOKENS: ThemeTokenEntry[] = [
  // ── Colors ────────────────────────────────────────────────────────────────
  {
    cssVar: '--hmi-bg',
    themePath: 'colors.bg',
    section: 'colors',
    inputType: 'color',
    label: 'Background',
  },
  {
    cssVar: '--hmi-surface',
    themePath: 'colors.surface',
    section: 'colors',
    inputType: 'color',
    label: 'Surface',
  },
  {
    cssVar: '--hmi-surface-raised',
    themePath: 'colors.surface_raised',
    section: 'colors',
    inputType: 'color',
    label: 'Raised Surface',
  },
  {
    cssVar: '--hmi-text',
    themePath: 'colors.text',
    section: 'colors',
    inputType: 'color',
    label: 'Text',
  },
  {
    cssVar: '--hmi-text-muted',
    themePath: 'colors.text_muted',
    section: 'colors',
    inputType: 'color',
    label: 'Muted Text',
  },
  {
    cssVar: '--hmi-accent',
    themePath: 'colors.accent',
    section: 'colors',
    inputType: 'color',
    label: 'Accent',
  },
  {
    cssVar: '--hmi-border',
    themePath: 'colors.border',
    section: 'colors',
    inputType: 'color',
    label: 'Border',
  },
  {
    cssVar: '--hmi-ok',
    themePath: 'colors.ok',
    section: 'colors',
    inputType: 'color',
    label: 'OK',
  },
  {
    cssVar: '--hmi-warn',
    themePath: 'colors.warn',
    section: 'colors',
    inputType: 'color',
    label: 'Warn',
  },
  {
    cssVar: '--hmi-fault',
    themePath: 'colors.fault',
    section: 'colors',
    inputType: 'color',
    label: 'Fault',
  },

  // ── Typography (7 combos × font / size / weight / tracking / transform) ─────
  ...typographyCombo('heading', 'Heading'),
  ...typographyCombo('subheading', 'Subheading'),
  ...typographyCombo('body', 'Body'),
  ...typographyCombo('caption', 'Caption'),
  ...typographyCombo('code', 'Code'),
  ...typographyCombo('value', 'Value'),
  ...typographyCombo('label', 'Label'),

  // ── Spacing, Radius & Shadow ────────────────────────────────────────────────
  {
    cssVar: '--hmi-space-sm',
    themePath: 'spacing.space_sm',
    section: 'spacing',
    inputType: 'text',
    group: 'Spacing',
    label: 'Small',
  },
  {
    cssVar: '--hmi-space-md',
    themePath: 'spacing.space_md',
    section: 'spacing',
    inputType: 'text',
    group: 'Spacing',
    label: 'Medium',
  },
  {
    cssVar: '--hmi-space-lg',
    themePath: 'spacing.space_lg',
    section: 'spacing',
    inputType: 'text',
    group: 'Spacing',
    label: 'Large',
  },
  {
    cssVar: '--hmi-radius-sm',
    themePath: 'spacing.radius_sm',
    section: 'spacing',
    inputType: 'text',
    group: 'Border Radius',
    label: 'Small',
  },
  {
    cssVar: '--hmi-radius',
    themePath: 'spacing.radius_md',
    section: 'spacing',
    inputType: 'text',
    group: 'Border Radius',
    label: 'Medium',
  },
  {
    cssVar: '--hmi-radius-lg',
    themePath: 'spacing.radius_lg',
    section: 'spacing',
    inputType: 'text',
    group: 'Border Radius',
    label: 'Large',
  },
  {
    cssVar: '--hmi-shadow',
    themePath: 'spacing.shadow',
    section: 'spacing',
    inputType: 'text',
    group: 'Shadow',
    wide: true,
    label: 'Shadow',
  },
];

// ── Derived lookups ───────────────────────────────────────────────────────────

/** Default theme — single source of truth, shared with backend Pydantic models. */
export const DEFAULT_THEME: ThemeConfig = themeDefaults as ThemeConfig;

/** Returns a fresh deep clone of the default theme. */
export function defaultTheme(): ThemeConfig {
  return JSON.parse(JSON.stringify(DEFAULT_THEME));
}

interface ThemeSectionDescriptor {
  key: ThemeSection;
  title: string;
  tokens: ThemeTokenEntry[];
}

const SECTION_TITLES: Record<ThemeSection, string> = {
  colors: 'Colors',
  typography: 'Typography',
  spacing: 'Spacing, Radius & Shadow',
};

/** Sections derived from THEME_TOKENS, in registry order. */
export function themeSections(): ThemeSectionDescriptor[] {
  const sections: Record<ThemeSection, ThemeSectionDescriptor> = {
    colors: { key: 'colors', title: SECTION_TITLES.colors, tokens: [] },
    typography: { key: 'typography', title: SECTION_TITLES.typography, tokens: [] },
    spacing: { key: 'spacing', title: SECTION_TITLES.spacing, tokens: [] },
  };
  for (const token of THEME_TOKENS) {
    sections[token.section].tokens.push(token);
  }
  return [sections.colors, sections.typography, sections.spacing];
}

function getThemeValue(theme: ThemeConfig, path: string): string | number {
  const [group, field] = path.split('.');
  if (!group || !field) return '';
  const root = theme as unknown as Record<string, unknown>;
  const value = (root[group] as Record<string, unknown> | undefined)?.[field];
  if (typeof value === 'string' || typeof value === 'number') return value;
  return '';
}

export function applyThemeTokens(theme: ThemeConfig): void {
  const root = document.documentElement;
  for (const token of THEME_TOKENS) {
    const value = getThemeValue(theme, token.themePath);
    root.style.setProperty(token.cssVar, String(value));
  }
}

// ── Multi-theme runtime cache ───────────────────────────────────────────────
// All themes are loaded up front so the operator can switch instantly without a
// round-trip. Switching just re-applies a cached ThemeConfig's tokens.

let loadedThemes: Record<string, ThemeConfig> = {};
let defaultThemeId = '';

/** The theme id the operator last switched to, or '' to follow the default. */
let activeThemeId = '';

export function getLoadedThemes(): Record<string, ThemeConfig> {
  return loadedThemes;
}

/**
 * Replace the runtime theme cache without a network round-trip — used by the
 * config editor, which has already fetched the index via its own `load()`, to
 * keep the runtime cache in sync after a save/create/delete.
 */
export function setLoadedThemes(themes: Record<string, ThemeConfig>, defaultId: string): void {
  loadedThemes = themes;
  defaultThemeId = defaultId;
  // That fetch counts: `ensureThemeTokens()` has nothing left to ask for.
  themesLoaded = true;
}

export function getActiveThemeId(): string {
  return activeThemeId || defaultThemeId;
}

/** Apply a loaded theme's tokens by id. Returns false if the id isn't loaded. */
export function applyThemeById(id: string): boolean {
  const theme = loadedThemes[id];
  if (!theme) return false;
  activeThemeId = id;
  applyThemeTokens(theme);
  return true;
}

let themeLoad: Promise<void> | null = null;
let themesLoaded = false;

/**
 * Set once the editor's live-preview iframe pins an unsaved draft (see
 * `applyPreviewTheme`). A background index load still refreshes the cache but
 * must not repaint over the draft the author is looking at.
 */
let previewPinned = false;

/**
 * Paint an unsaved theme draft and pin it for this document.
 *
 * Only the editor's live-preview iframe does this — it renders whatever the
 * Themes view is previewing right now, which by definition is not what
 * `/api/themes` would return.
 */
export function applyPreviewTheme(theme: ThemeConfig): void {
  previewPinned = true;
  applyThemeTokens(theme);
}

/**
 * Fetch every project theme and apply the active one's tokens to the document.
 * Idempotent: the first call's promise is cached and returned for subsequent
 * calls, so multiple call sites share a single network round-trip. Pass
 * `{ force: true }` to bypass the cache (e.g. from a cross-tab save event).
 *
 * Never rejects — a failed load leaves the tokens already on the document and
 * lets `ensureThemeTokens()` try again.
 */
export function loadAndApplyThemeTokens(opts?: { force?: boolean }): Promise<void> {
  if (themeLoad && !opts?.force) return themeLoad;
  themeLoad = (async () => {
    try {
      const index = await apiJson<ThemesIndex>('/api/themes');
      loadedThemes = Object.fromEntries(index.themes.map((t) => [t.id, t.config]));
      defaultThemeId = index.default;
      themesLoaded = true;
      // If the operator's active theme was deleted in another tab, stop
      // following it so activeThemeId / getActiveThemeId() stay consistent with
      // what's actually applied (falls back to the default below).
      if (activeThemeId && !loadedThemes[activeThemeId]) activeThemeId = '';
      const target = (activeThemeId && loadedThemes[activeThemeId]) || loadedThemes[defaultThemeId];
      if (!previewPinned) applyThemeTokens(target ?? DEFAULT_THEME);
    } catch {
      // Keep current token values when the theme fetch fails. Defaults were
      // already applied at module load (see below). Clear the cached promise so
      // ensureThemeTokens() retries the next time the app learns the backend is
      // serving — no timer, no fixed delay.
      themeLoad = null;
    }
  })();
  return themeLoad;
}

/**
 * Load the theme index unless it is already loaded or in flight.
 *
 * The app calls this at startup and again whenever the WebSocket opens: on
 * first boot the backend can still be coming up behind the manager proxy, and
 * the socket connecting is the app's own proof that it is now serving.
 */
export function ensureThemeTokens(): Promise<void> {
  if (themesLoaded) return Promise.resolve();
  return loadAndApplyThemeTokens();
}

// Apply default tokens at module load so the very first paint already has the
// design palette in place — without depending on the /api/theme call resolving.
// Project themes loaded later via applyThemeTokens() override these.
if (typeof document !== 'undefined') {
  applyThemeTokens(DEFAULT_THEME);
}
