/**
 * ThemeEditor — the per-theme token editor body.
 *
 * Presentational: renders the validation notices and the Colors / Typography /
 * Spacing sections (derived from the shared `THEME_TOKENS` registry) for one
 * theme, delegating edits and per-section reset to its parent (ThemesView).
 *
 * Each setting is shown exactly once, with its live preview folded into the
 * field itself — a colour field is its own swatch, a typography combo renders a
 * specimen beside its inputs, a spacing/radius/shadow field shows the metric it
 * controls. No separate "preview card" repeats the list of settings.
 */

import { type CSSProperties } from 'react';
import Button from '../../ui/Button';
import Select from '../../ui/Select';
import AdminSection from '../../admin/AdminSection';
import { LengthField } from '@config/utils/LengthField';
import useCommittableDraft from '@config/hooks/useCommittableDraft';
import type { ThemeConfig } from '@shared/types/theme';
import { themeSections, type ThemeSection, type ThemeTokenEntry } from '@shared/utils/themeTokens';

// ── Font presets ──────────────────────────────────────────────────────────────

interface FontPreset {
  label: string;
  value: string;
}

// All presets are self-hosted (bundled) fonts so config and projects render
// identically on every OS. System stacks remain only as last-resort fallbacks
// inside each value, never as a selectable choice. Every bundled font is offered
// for every font token (heading, body, caption, code, value, …).
const FONT_PRESETS: FontPreset[] = [
  { label: 'Inter (bundled)', value: "'Inter', system-ui, sans-serif" },
  { label: 'Manrope (bundled)', value: "'Manrope', system-ui, sans-serif" },
  { label: 'Lexend (bundled)', value: "'Lexend', system-ui, sans-serif" },
  {
    label: 'Roboto Mono (bundled)',
    value: "'Roboto Mono', 'Courier New', 'Consolas', 'Monaco', monospace",
  },
  {
    label: 'JetBrains Mono (bundled)',
    value: "'JetBrains Mono', 'Courier New', 'Consolas', 'Monaco', monospace",
  },
];

// ── Color helpers (client-side WCAG contrast) ─────────────────────────────────

function normalizeHex(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/^rgba?\(/i.test(trimmed)) return trimmed;
  const stripped = trimmed.replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(stripped)) {
    return (
      '#' +
      stripped
        .split('')
        .map((c) => c + c)
        .join('')
    );
  }
  if (/^[0-9a-fA-F]{6}$/.test(stripped)) return '#' + stripped.toLowerCase();
  return trimmed;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number | null {
  const a = hexToRgb(normalizeHex(fg));
  const b = hexToRgb(normalizeHex(bg));
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Per-token contrast pairings shown as inline badges in the editor. */
const CONTRAST_PAIRS: Record<string, { against: string; label: string }[]> = {
  'colors.text': [
    { against: 'colors.bg', label: 'on bg' },
    { against: 'colors.surface', label: 'on surface' },
  ],
  'colors.text_muted': [
    { against: 'colors.bg', label: 'on bg' },
    { against: 'colors.surface', label: 'on surface' },
  ],
};

function readThemeValue(theme: ThemeConfig, path: string): string {
  const [section, field] = path.split('.');
  const sectionData = (theme as unknown as Record<string, Record<string, unknown>>)[section];
  return sectionData ? String(sectionData[field] ?? '') : '';
}

// ── Editor body ───────────────────────────────────────────────────────────────

interface ThemeEditorProps {
  theme: ThemeConfig;
  error: string | null;
  onChangeField(themePath: string, value: unknown): void;
  onResetSection(section: ThemeSection): void;
}

export default function ThemeEditor({
  theme,
  error,
  onChangeField,
  onResetSection,
}: ThemeEditorProps) {
  return (
    <div className="cfg-theme-view">
      {error && <div className="cfg-theme-notice cfg-theme-notice--error">Validation: {error}</div>}
      <div className="cfg-theme-content">
        {themeSections().map((section) => (
          <ThemeSectionEditor
            key={section.key}
            section={section}
            theme={theme}
            onChangeField={onChangeField}
            onResetSection={onResetSection}
          />
        ))}
      </div>
    </div>
  );
}

// ── Section editor ────────────────────────────────────────────────────────────

interface ThemeSectionEditorProps {
  section: ReturnType<typeof themeSections>[number];
  theme: ThemeConfig;
  onChangeField(themePath: string, value: unknown): void;
  onResetSection(section: ThemeSection): void;
}

function ThemeSectionEditor({
  section,
  theme,
  onChangeField,
  onResetSection,
}: ThemeSectionEditorProps) {
  function handleReset() {
    if (!confirm(`Reset ${section.title} to defaults?`)) return;
    onResetSection(section.key as ThemeSection);
  }

  return (
    <AdminSection
      title={section.title}
      actions={
        <Button variant="ghost" size="sm" onClick={handleReset}>
          Reset
        </Button>
      }
    >
      <SectionDescription section={section.key as ThemeSection} />
      <SectionBody section={section} theme={theme} onChangeField={onChangeField} />
    </AdminSection>
  );
}

const SECTION_HINTS: Record<ThemeSection, string> = {
  colors:
    'Each swatch is the live value — edit the colour or hex inline. Contrast badges flag readability against the background and surface.',
  typography:
    'Seven reusable text styles. The specimen beside each combo previews the exact font, size, weight, letter spacing and case as you edit.',
  spacing:
    'Spacing, corner radius and elevation. The shape next to each field is drawn at the value you enter.',
};

function SectionDescription({ section }: { section: ThemeSection }) {
  return <p className="cfg-theme-hint">{SECTION_HINTS[section]}</p>;
}

function SectionBody({
  section,
  theme,
  onChangeField,
}: {
  section: ReturnType<typeof themeSections>[number];
  theme: ThemeConfig;
  onChangeField: (themePath: string, value: unknown) => void;
}) {
  if (section.key === 'colors') {
    return (
      <div className="cfg-theme-grid">
        {section.tokens.map((token) => (
          <ColorField
            key={token.themePath}
            token={token}
            theme={theme}
            value={readThemeValue(theme, token.themePath)}
            onChange={onChangeField}
          />
        ))}
      </div>
    );
  }

  if (section.key === 'typography') {
    return (
      <div className="cfg-theme-combos">
        {groupTokens(section.tokens).map((group) => (
          <TypographyCombo
            key={group.name}
            name={group.name}
            tokens={group.tokens}
            theme={theme}
            onChange={onChangeField}
          />
        ))}
      </div>
    );
  }

  // spacing / radius / shadow
  return (
    <div className="cfg-theme-metric-groups">
      {groupTokens(section.tokens).map((group) => (
        <div key={group.name} className="cfg-theme-metric-group">
          <h4>{group.name}</h4>
          <div className="cfg-theme-metric-rows">
            {group.tokens.map((token) => (
              <MetricField
                key={token.themePath}
                token={token}
                value={readThemeValue(theme, token.themePath)}
                onChange={onChangeField}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Group tokens by their `group` label, preserving registry order.
function groupTokens(tokens: ThemeTokenEntry[]): { name: string; tokens: ThemeTokenEntry[] }[] {
  const groups: { name: string; tokens: ThemeTokenEntry[] }[] = [];
  for (const token of tokens) {
    const name = token.group ?? '';
    let group = groups.find((g) => g.name === name);
    if (!group) {
      group = { name, tokens: [] };
      groups.push(group);
    }
    group.tokens.push(token);
  }
  return groups;
}

// ── Typography combo (specimen + font / size / weight inputs) ──────────────────

/** Sample text shown in each combo's live specimen, keyed by combo css key. */
const SPECIMEN_TEXT: Record<string, string> = {
  heading: 'Heading',
  subheading: 'Subheading',
  body: 'The quick brown fox jumps over the lazy dog',
  caption: 'Caption · helper text',
  code: 'const flow = 42.0;',
  value: '42.0',
  label: 'Section label',
};

function comboKey(tokens: ThemeTokenEntry[]): string {
  // e.g. `typography.heading_font` → `heading`
  const path = tokens[0]?.themePath ?? '';
  return path.split('.')[1]?.replace(/_(font|size|weight|tracking|transform)$/, '') ?? '';
}

function TypographyCombo({
  name,
  tokens,
  theme,
  onChange,
}: {
  name: string;
  tokens: ThemeTokenEntry[];
  theme: ThemeConfig;
  onChange: (themePath: string, value: unknown) => void;
}) {
  const key = comboKey(tokens);
  return (
    <div className="cfg-theme-combo">
      <div className="cfg-theme-combo__specimen">
        <span className={`cfg-theme-pv-type cfg-theme-pv-type--${key}`}>
          {SPECIMEN_TEXT[key] ?? name}
        </span>
        <span className="cfg-theme-combo__name">{name}</span>
      </div>
      <div className="cfg-theme-combo__fields">
        {tokens.map((token) => (
          <ComboField
            key={token.themePath}
            token={token}
            value={readThemeValue(theme, token.themePath)}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function ComboField({
  token,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  if (token.inputType === 'font') {
    return <FontField token={token} value={value} onChange={onChange} />;
  }
  if (token.inputType === 'number') {
    return <NumberField token={token} value={value} onChange={onChange} />;
  }
  if (token.inputType === 'select') {
    return <SelectField token={token} value={value} onChange={onChange} />;
  }
  // Remaining text inputs in a combo (size, tracking) are CSS lengths.
  return (
    <div className="cfg-theme-input-group">
      <label className="cfg-theme-label">{token.label}</label>
      <LengthField
        value={value}
        placeholder={token.placeholder}
        unitMode="select"
        units={THEME_LENGTH_UNITS}
        emptyCommit=""
        onChange={(v) => onChange(token.themePath, v)}
      />
    </div>
  );
}

// ── Metric field (spacing / radius / shadow) with inline shape preview ─────────

function MetricField({
  token,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  const variant =
    token.group === 'Spacing' ? 'space' : token.group === 'Border Radius' ? 'radius' : 'shadow';
  return (
    <div className={`cfg-theme-metric cfg-theme-metric--${variant}`}>
      <label className="cfg-theme-label">{token.label}</label>
      <div className="cfg-theme-metric__row">
        <span
          className={`cfg-theme-metric__shape cfg-theme-metric__shape--${variant}`}
          style={cssVarStyle('--cfg-pv', token.cssVar)}
        />
        {variant === 'shadow' ? (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(token.themePath, e.target.value)}
            className="cfg-prop-input"
            placeholder={token.placeholder}
          />
        ) : (
          <LengthField
            value={value}
            placeholder={token.placeholder}
            unitMode="select"
            units={THEME_LENGTH_UNITS}
            emptyCommit=""
            onChange={(v) => onChange(token.themePath, v)}
          />
        )}
      </div>
    </div>
  );
}

// ── Primitive fields ───────────────────────────────────────────────────────────

/** The theme's own length vocabulary: `rem` first, since the type and spacing
 *  scales are authored in it. */
const THEME_LENGTH_UNITS = ['rem', 'px', 'em', '%'] as const;

function cssVarStyle(prop: string, cssVar: string): CSSProperties {
  return { [prop]: `var(${cssVar})` } as CSSProperties;
}

function NumberField({
  token,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  return (
    <div className="cfg-theme-input-group">
      <label className="cfg-theme-label">{token.label}</label>
      <input
        type="number"
        min={token.min}
        max={token.max}
        step={token.step}
        value={value}
        onChange={(e) => {
          const next = Number.parseInt(e.target.value, 10);
          if (!Number.isFinite(next)) return;
          onChange(token.themePath, next);
        }}
        className="cfg-prop-input cfg-theme-length__num"
      />
    </div>
  );
}

function SelectField({
  token,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  return (
    <div className="cfg-theme-input-group">
      <label className="cfg-theme-label">{token.label}</label>
      <Select value={value} onChange={(v) => onChange(token.themePath, v)}>
        {(token.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ── Color field with WCAG contrast badges + hex normalization ─────────────────

function ColorField({
  token,
  theme,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  theme: ThemeConfig;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  // Blur/Enter commit rather than per-keystroke: a half-typed hex is not a
  // colour, and the hook's post-blur resync is what tidies `fff` to `#fff`
  // even when the normalised text matches what is already stored.
  const { draft, inputProps } = useCommittableDraft(value, (text) => {
    const normalized = normalizeHex(text);
    if (normalized !== value) onChange(token.themePath, normalized);
  });

  const pickerValue = hexToRgb(normalizeHex(draft)) ? normalizeHex(draft) : '#000000';
  const pairings = CONTRAST_PAIRS[token.themePath] ?? [];

  return (
    <div className="cfg-theme-input-group">
      <label className="cfg-theme-label">{token.label}</label>
      <input
        type="color"
        value={pickerValue}
        onChange={(e) => onChange(token.themePath, e.target.value)}
        className="cfg-theme-color-input"
      />
      <input type="text" {...inputProps} className="cfg-prop-input" placeholder="#000000" />
      {pairings.length > 0 && (
        <div className="cfg-theme-contrast-badges">
          {pairings.map((pair) => (
            <ContrastBadge
              key={pair.against}
              fg={value}
              bg={readThemeValue(theme, pair.against)}
              label={pair.label}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContrastBadge({ fg, bg, label }: { fg: string; bg: string; label: string }) {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null) return null;
  const passesAA = ratio >= 4.5;
  const passesAAA = ratio >= 7;
  const cls = passesAAA
    ? 'cfg-theme-contrast--aaa'
    : passesAA
      ? 'cfg-theme-contrast--aa'
      : 'cfg-theme-contrast--fail';
  const tier = passesAAA ? 'AAA' : passesAA ? 'AA' : 'FAIL';
  return (
    <span className={`cfg-theme-contrast ${cls}`} title={`${label}: ratio ${ratio.toFixed(2)}:1`}>
      {label} · {ratio.toFixed(1)}:1 · {tier}
    </span>
  );
}

// ── Font picker (dropdown of presets + custom value) ──────────────────────────

function FontField({
  token,
  value,
  onChange,
}: {
  token: ThemeTokenEntry;
  value: string;
  onChange: (themePath: string, value: unknown) => void;
}) {
  const matchedPreset = FONT_PRESETS.find((p) => p.value === value);

  return (
    <div className={`cfg-theme-input-group${token.wide ? ' cfg-theme-input-group--wide' : ''}`}>
      <label className="cfg-theme-label">{token.label}</label>
      <Select
        value={value}
        onChange={(v) => onChange(token.themePath, v)}
        style={{ fontFamily: value || undefined }}
      >
        {!matchedPreset && (
          <option value={value} style={{ fontFamily: value || undefined }}>
            {value}
          </option>
        )}
        {FONT_PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value} style={{ fontFamily: preset.value }}>
            {preset.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
