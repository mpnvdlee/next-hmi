import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import CloseButton from './CloseButton';
import { useTranslationStore } from '@shared/store/translationStore';
import { VirtualKeyIcon } from './VirtualKeyIcon';

// One flat grid so the theme's column count (hmi.css) can move Back/Clear/Enter beside the digits.
const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '-'] as const;

interface VirtualNumpadProps {
  isOpen: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter with a value that parses and sits inside min/max. */
  onApply: (value: string) => void;
  /** Called on ×, Escape, or a press outside the panel: the entry is dropped. */
  onCancel: () => void;
  /** Ref to the anchor element — clicks on it will not cancel. */
  anchorRef?: { readonly current: Element | null };
  title?: string;
  dockPosition?: 'center' | 'bottom-right';
  /** Bounds a value must sit inside to be applied; out of range, Enter is disabled and the panel says why. */
  min?: number;
  max?: number;
  unit?: string;
  /** Whether min/max show as a hint under the title. They gate Enter either way. Default true. */
  showRange?: boolean;
  /** Said instead of the range when the entry is outside min/max, such as why a limit depends on another setting. */
  rangeMessage?: string;
  /** The value being replaced: the entry field's placeholder while the entry is empty. */
  currentValue?: string;
  /** Digits allowed after the point; 0 disables the point. Omit for no limit. */
  decimals?: number;
  /** Whether the minus key works. Default: true unless min is 0 or more. */
  allowNegative?: boolean;
  /** Masks the entry, for a PIN. */
  password?: boolean;
  /** Drawn in place inside its widget rather than as a floating panel: no ×, and a press outside cancels nothing. */
  inline?: boolean;
  /** Whether the entry field takes focus as it appears. Default true. */
  autoFocus?: boolean;
}

/** Whether an entry obeys the key rules: one optional leading minus, one point, the decimals limit. */
function fitsRules(text: string, decimals: number | undefined, allowNegative: boolean) {
  const match = /^(-?)\d*(\.(\d*))?$/.exec(text);
  if (!match || (match[1] && !allowNegative) || (match[2] && decimals === 0)) return false;
  return decimals === undefined || (match[3] ?? '').length <= decimals;
}

/** The range as numbers, which need no translation: `80 – 200`, `≥ 0`, `≤ 10`. */
function rangeText(min: number | undefined, max: number | undefined) {
  if (min !== undefined && max !== undefined) return `${min} \u2013 ${max}`;
  return min !== undefined ? `\u2265 ${min}` : `\u2264 ${max}`;
}

export function VirtualNumpad({
  isOpen,
  value,
  onChange,
  onApply,
  onCancel,
  anchorRef,
  title,
  dockPosition = 'bottom-right',
  min,
  max,
  unit,
  showRange = true,
  rangeMessage: customRangeMessage,
  currentValue,
  decimals,
  allowNegative = !(min !== undefined && min >= 0),
  password = false,
  inline = false,
  autoFocus = true,
}: VirtualNumpadProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The keys show icons and numbers; their names for a screen reader are
  // dictionary keys, English as on any screen. Subscribed so a language switch
  // re-renders an open numpad.
  useTranslationStore((s) => s.activeLanguage);
  useTranslationStore((s) => s.translations);
  const t = useTranslationStore.getState().resolve;

  useEffect(() => {
    if (!isOpen || inline) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) {
        // A press on the widget keeps the typing focus in the entry field.
        if (event.type === 'mousedown') event.preventDefault();
        return;
      }
      onCancel();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, inline, onCancel, anchorRef]);

  if (!isOpen) return null;

  const applyKey = (key: string) => {
    if (key === '-') {
      if (!allowNegative) return;
      onChange(value ? (value.startsWith('-') ? value.slice(1) : `-${value}`) : '-');
      return;
    }
    const next = key === '.' && (!value || value === '-') ? `${value}0.` : `${value}${key}`;
    if (fitsRules(next, decimals, allowNegative)) onChange(next);
  };

  // A centred numpad sits in the middle of the screen; the keyboard's centre dock stays at the bottom.
  const dockClass = `hmi-virtual-input__dock hmi-virtual-input__dock--${dockPosition === 'center' ? 'middle' : dockPosition}`;

  const parsed = parseFloat(value);
  const isOutOfRange =
    !isNaN(parsed) && ((min !== undefined && parsed < min) || (max !== undefined && parsed > max));
  const canApply = !isNaN(parsed) && !isOutOfRange;
  const apply = () => {
    if (canApply) onApply(value);
  };
  const hasRange = showRange && (min !== undefined || max !== undefined);
  // The String Input's masking: CSS where supported, so no browser offers to
  // save the PIN, and a real password field where it is not.
  const maskedByCss = password && CSS.supports('-webkit-text-security', 'disc');
  const keyDisabled = (key: string) =>
    (key === '-' && !allowNegative) || (key === '.' && decimals === 0);

  const panel = (
    <div
      className={`hmi-virtual-input__panel hmi-virtual-input__panel--compact${inline ? ' hmi-virtual-input__panel--inline' : ''}`}
      ref={panelRef}
      // Keeps the focus, and with it the caret, in the entry field while keys are pressed.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      {(title || !inline) && (
        <div className="hmi-virtual-input__header">
          {title && <span className="hmi-virtual-input__title">{title}</span>}
          {!inline && (
            <CloseButton
              className="hmi-virtual-input__close"
              onClick={onCancel}
              label={t('Close numpad')}
            />
          )}
        </div>
      )}
      <div
        className={`hmi-virtual-input__value${isOutOfRange ? ' hmi-virtual-input__value--invalid' : ''}`}
      >
        {/* A physical keyboard types here through the same rules; Escape is the document listener's.
              inputMode none keeps a tablet's own keyboard shut. */}
        <input
          className={`hmi-virtual-input__field${maskedByCss ? ' hmi-virtual-input__field--masked' : ''}`}
          type={password && !maskedByCss ? 'password' : 'text'}
          inputMode="none"
          autoFocus={autoFocus}
          aria-label={title || 'Value'}
          value={value}
          placeholder={currentValue || '0'}
          onChange={(e) => {
            if (fitsRules(e.target.value, decimals, allowNegative)) onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === 'Enter') apply();
            else if ((NUMPAD_KEYS as readonly string[]).includes(e.key)) applyKey(e.key);
            else return;
            e.preventDefault();
          }}
        />
        {unit && <span className="hmi-virtual-input__value-unit">{unit}</span>}
      </div>
      {/* Out of range, the range itself turns into the error, unless the widget says why in words. */}
      {hasRange && !(isOutOfRange && !customRangeMessage) && (
        <div className="hmi-virtual-input__range">{rangeText(min, max)}</div>
      )}
      {isOutOfRange && (
        <div className="hmi-virtual-input__error" role="alert">
          <VirtualKeyIcon name="warning" />
          {customRangeMessage || rangeText(min, max)}
        </div>
      )}
      <div className="hmi-virtual-input__keys">
        {NUMPAD_KEYS.map((key) => (
          <button
            type="button"
            key={key}
            className="hmi-virtual-input__key"
            onClick={() => applyKey(key)}
            disabled={keyDisabled(key)}
            tabIndex={-1}
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          className="hmi-virtual-input__key hmi-virtual-input__key--action hmi-virtual-input__key--back"
          onClick={() => onChange(value.slice(0, -1))}
          tabIndex={-1}
          aria-label={t('Back')}
        >
          <VirtualKeyIcon name="backspace" />
        </button>
        <button
          type="button"
          className="hmi-virtual-input__key hmi-virtual-input__key--action hmi-virtual-input__key--clear"
          onClick={() => onChange('')}
          tabIndex={-1}
          aria-label={t('Clear')}
        >
          <VirtualKeyIcon name="clear" />
        </button>
        <button
          type="button"
          className="hmi-virtual-input__key hmi-virtual-input__key--action hmi-virtual-input__key--accent"
          onClick={apply}
          disabled={!canApply}
          tabIndex={-1}
          aria-label={t('Enter')}
        >
          <VirtualKeyIcon name="enter" />
        </button>
      </div>
    </div>
  );
  return inline ? panel : createPortal(<div className={dockClass}>{panel}</div>, document.body);
}
