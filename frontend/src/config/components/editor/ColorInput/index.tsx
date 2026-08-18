/**
 * ColorInput — color property editor for the Properties Panel.
 *
 * Realizes the panel-wide theming model for colors:
 *   - **Unset** follows the theme — the element falls back to its CSS token. The
 *     trigger names that fallback at value size ("Accent") with a muted
 *     "· default" suffix behind it. Naming the token is what says "themed" —
 *     a set color reads as a hex — so the suffix stays the same word every
 *     field uses. A field with no token behind it paints nothing, so it names
 *     that state "Transparent · default" — the same thing the Transparent
 *     palette entry sets explicitly, minus the suffix.
 *   - Picking a **theme token** pins the value to `var(--hmi-*)` so it re-skins with
 *     the theme. That is an explicit value, so it reads as plain black text with no
 *     suffix — only an unset fallback gets the muted treatment.
 *   - Picking a **suggested / custom color** sets a fixed hex that does NOT re-skin.
 *   - The `×` in the row's action column reverts an override back to following the theme.
 *
 * The editor opens as pinned Default row → scrollable theme-token/suggested
 * list → pinned Custom row, so each color type reads as its own zone and
 * nothing scrolls underneath the header's close button. The popup floats
 * (`position: fixed`) so the field box's `overflow: hidden` can't clip it.
 *
 * To extend the suggested colors, add entries to COLOR_PALETTE below.
 */

import './style.css';
import { useState, useRef, useEffect } from 'react';
import CloseButton from '@shared/components/CloseButton';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';
import { useOwnerWindow } from '@shared/components/PopoutWindow/windowContext';
import { withUnsetHint } from '@config/utils/withUnsetHint';
import {
  THEME_COLOR_TOKENS,
  parseTokenVar,
  resolveTokenValues,
  tokenLabel,
  tokenVar,
} from '@shared/utils/themeDefaultHint';

const TRANSPARENT = 'transparent';

const COLOR_PALETTE: { name: string; value: string }[] = [
  // HMI bright core palette
  { name: 'Electric Blue', value: '#2D9CFF' },
  { name: 'Cyan', value: '#00CFE8' },
  { name: 'Signal Green', value: '#1FBF75' },
  { name: 'Safety Amber', value: '#F2A93B' },
  { name: 'Alarm Red', value: '#E74C3C' },
  { name: 'Violet', value: '#8B5CF6' },
  { name: 'Magenta', value: '#EC4899' },
  { name: 'Lime', value: '#84CC16' },
  // HMI status aliases
  { name: 'Status OK', value: '#1FBF75' },
  { name: 'Status Warn', value: '#F2A93B' },
  { name: 'Status Alarm', value: '#E74C3C' },
  { name: 'Status Info', value: '#2D9CFF' },
  // Neutrals
  { name: 'Slate Gray', value: '#6B7280' },
  { name: 'White', value: '#FFFFFF' },
  { name: 'Transparent', value: TRANSPARENT },
];

/** Uppercase a hex value for display, passing anything non-hex through unchanged. */
function formatHex(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim().toUpperCase() : value;
}

/** Display name for a literal color: its palette name, or the uppercased hex. */
function colorName(value: string): string {
  const hit = COLOR_PALETTE.find((c) => c.value.toLowerCase() === value.trim().toLowerCase());
  return hit ? hit.name : formatHex(value);
}

interface ColorInputProps {
  value: unknown;
  onChange: (v: string | undefined) => void;
  /** Theme token (cssVar) an unset value falls back to — shown as the themed default. */
  defaultToken?: string;
  /** A multi-selection whose widgets hold different colors. The trigger reads
   *  "Mixed" over an unpainted swatch and offers no revert: there is no single
   *  color to preview, and none of the widgets is following the default. Picking
   *  one applies it to all of them. */
  mixed?: boolean;
}

export default function ColorInput({
  value,
  onChange,
  defaultToken,
  mixed = false,
}: ColorInputProps) {
  const colorValue = typeof value === 'string' && value ? value : undefined;
  const tokenCssVar = parseTokenVar(colorValue);
  const fixedHex = colorValue && !tokenCssVar ? colorValue : undefined;

  const ownerWindow = useOwnerWindow();
  const [open, setOpen] = useState(false);
  // Fixed viewport coords for the popup — the trigger sits inside a
  // `.cfg-field-group__box` with `overflow: hidden`, so a normally positioned
  // popup would clip. `position: fixed` escapes the scroll box.
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const customInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useDismissOnOutsideClick(wrapperRef, () => setOpen(false), open);

  useEffect(() => {
    if (!open || !wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const width = 220;
    const left = Math.min(rect.left, ownerWindow.innerWidth - width - 8);
    setPopupPos({ top: rect.bottom + 6, left: Math.max(8, left) });
  }, [open, ownerWindow]);

  // One getComputedStyle read for every token this render needs.
  const tokenValues = resolveTokenValues([
    ...THEME_COLOR_TOKENS.map((t) => t.cssVar),
    ...(defaultToken ? [defaultToken] : []),
    ...(tokenCssVar ? [tokenCssVar] : []),
  ]);

  function select(v: string | undefined) {
    onChange(v);
    setOpen(false);
  }

  // Trigger presentation derives from one state — a pinned token, a fixed color,
  // or the fallback (unset) — so swatch, label, and title can't drift. An
  // unpainted fallback (`!bg`) is what checkers the swatch below.
  const trigger = ((): { bg?: string; label: string; title: string } => {
    if (mixed) {
      return { label: 'Mixed', title: 'Mixed colors — pick one to apply to every selection' };
    }
    if (tokenCssVar) {
      return {
        bg: tokenVar(tokenCssVar),
        label: tokenLabel(tokenCssVar),
        title: `Pinned to theme token · ${tokenLabel(tokenCssVar)} (${tokenValues[tokenCssVar]})`,
      };
    }
    if (fixedHex) {
      return {
        bg: fixedHex === TRANSPARENT ? undefined : fixedHex,
        label: colorName(fixedHex),
        title: fixedHex,
      };
    }
    if (defaultToken) {
      return {
        bg: tokenVar(defaultToken),
        label: tokenLabel(defaultToken),
        title: `Follows theme · ${tokenLabel(defaultToken)} (${tokenValues[defaultToken]})`,
      };
    }
    // No theme token behind the field means it paints nothing of its own — the
    // same result the Transparent option sets explicitly, so it reads as that
    // rather than as an anonymous "Default".
    return { label: 'Transparent', title: 'Falls back to transparent' };
  })();

  // Color always has a fallback to name — a token's color, or transparent when
  // there is none — so unlike other schema types this is never null. `suffix`
  // stays the bare word (never `default(Token)`): the label already names the
  // token, so repeating it in the suffix would say it twice (see file doc above).
  const display = defaultToken
    ? {
        text: `${tokenLabel(defaultToken)} · ${formatHex(tokenValues[defaultToken])}`,
        suffix: 'default',
      }
    : { text: 'Transparent', suffix: 'default' };

  const triggerControl = (
    <>
      <button
        className={`cfg-color-picker__swatch${
          !trigger.bg ? ' cfg-color-picker__swatch--default' : ''
        }${open ? ' cfg-color-picker__swatch--selected' : ''}`}
        style={trigger.bg ? { backgroundColor: trigger.bg } : undefined}
        type="button"
        title={trigger.title}
        onClick={() => setOpen((o) => !o)}
      />
      <span
        className={`cfg-color-picker__label${
          colorValue ? ' cfg-color-picker__label--has-value' : ''
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger.label}
      </span>
    </>
  );

  return (
    <div className="cfg-color-picker" ref={wrapperRef}>
      {mixed ? (
        // Same wrapper the hint would have supplied, so the trigger keeps its
        // row-filling geometry (see `.cfg-color-picker > .cfg-prop-affix`).
        <div className="cfg-prop-affix">{triggerControl}</div>
      ) : (
        withUnsetHint(colorValue, (v) => onChange(v as string | undefined), triggerControl, display)
      )}

      {/* Lives outside the popup so it survives the popup closing — "Custom…"
          closes the dropdown immediately (like every other option) and hands
          off to this native swatch, which keeps running independently. */}
      <input
        ref={customInputRef}
        className="cfg-color-picker__input"
        type="color"
        value={fixedHex ?? '#2D9CFF'}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Floating popup — three clearly separated zones: a pinned Default row,
          a scrollable Theme/Suggested list, and a pinned Custom row. Default
          and Custom sit outside the scroll container so they're never lost
          in a scroll and never sit underneath the header's close button. */}
      {open && (
        <div className="cfg-color-picker__popup" style={{ top: popupPos.top, left: popupPos.left }}>
          <div className="cfg-color-picker__popup-header">
            <span className="cfg-color-picker__popup-title">Pick a color</span>
            <CloseButton
              tone="config"
              className="cfg-color-picker__close"
              title="Close"
              onClick={() => setOpen(false)}
            />
          </div>

          {/* The Default row previews the color the field actually falls back to,
              like the trigger does — the checkerboard means "transparent", not
              "unset", so it only appears when there is no token behind the field. */}
          <ColorOption
            name="Default"
            hex={
              defaultToken
                ? `${tokenLabel(defaultToken)} · ${formatHex(tokenValues[defaultToken])}`
                : 'Transparent'
            }
            swatch={defaultToken ? tokenVar(defaultToken) : undefined}
            defaultSwatch={!defaultToken}
            selected={!mixed && !colorValue}
            onClick={() => select(undefined)}
          />

          <div className="cfg-color-picker__options">
            <div className="cfg-color-picker__group-label">Theme colors</div>
            {THEME_COLOR_TOKENS.map((t) => (
              <ColorOption
                key={t.cssVar}
                name={t.label}
                hex={formatHex(tokenValues[t.cssVar])}
                swatch={tokenVar(t.cssVar)}
                selected={tokenCssVar === t.cssVar}
                onClick={() => select(tokenVar(t.cssVar))}
              />
            ))}
            <div className="cfg-color-picker__group-label cfg-color-picker__group-label--divided">
              Suggested colors
            </div>
            {COLOR_PALETTE.map((c) => {
              const clear = c.value === TRANSPARENT;
              return (
                <ColorOption
                  key={c.name}
                  name={c.name}
                  hex={clear ? '' : formatHex(c.value)}
                  swatch={clear ? undefined : c.value}
                  defaultSwatch={clear}
                  selected={fixedHex === c.value}
                  onClick={() => select(c.value)}
                />
              );
            })}
          </div>

          <div className="cfg-color-picker__custom-row">
            <button
              className="cfg-color-picker__option"
              type="button"
              title="Pick a custom color"
              onClick={() => {
                // Close the dropdown first (like every other option), then
                // hand off to the native swatch — it lives outside this
                // popup so it keeps running after the popup unmounts.
                setOpen(false);
                customInputRef.current?.click();
              }}
            >
              <span
                className="cfg-color-picker__swatch"
                style={{ backgroundColor: fixedHex ?? 'var(--cfg-border)' }}
              />
              <span className="cfg-color-picker__option-name">Custom…</span>
              <span className="cfg-color-picker__option-hex">
                {(fixedHex && formatHex(fixedHex)) || '—'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One row in the color list: swatch + name + hex. */
function ColorOption({
  name,
  hex,
  swatch,
  defaultSwatch,
  selected,
  onClick,
}: {
  name: string;
  hex: string;
  swatch?: string;
  defaultSwatch?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`cfg-color-picker__option${selected ? ' cfg-color-picker__option--selected' : ''}`}
      type="button"
      title={`${name}${hex ? ` · ${hex}` : ''}`}
      onClick={onClick}
    >
      <span
        className={`cfg-color-picker__swatch${defaultSwatch ? ' cfg-color-picker__swatch--default' : ''}`}
        style={swatch ? { backgroundColor: swatch } : undefined}
      />
      <span className="cfg-color-picker__option-name">{name}</span>
      {hex && <span className="cfg-color-picker__option-hex">{hex}</span>}
    </button>
  );
}
