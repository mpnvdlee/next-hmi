import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import CloseButton from './CloseButton';

const NUMPAD_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['0', '.', '-'],
] as const;

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
  /** The value being replaced: the placeholder while the entry is empty, and the "Current setpoint" line. */
  currentValue?: string;
  /** Digits allowed after the point; 0 disables the point. Omit for no limit. */
  decimals?: number;
  /** Whether the minus key works. Default: true unless min is 0 or more. */
  allowNegative?: boolean;
}

function rangeMessage(min: number | undefined, max: number | undefined, unit: string | undefined) {
  const suffix = unit ? ` ${unit}` : '';
  if (min !== undefined && max !== undefined)
    return `Enter a value between ${min} and ${max}${suffix}`;
  if (min !== undefined) return `Enter a value of at least ${min}${suffix}`;
  return `Enter a value of at most ${max}${suffix}`;
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
  currentValue,
  decimals,
  allowNegative = !(min !== undefined && min >= 0),
}: VirtualNumpadProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
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
  }, [isOpen, onCancel, anchorRef]);

  if (!isOpen) return null;

  const applyKey = (key: string) => {
    if (key === '-') {
      if (!allowNegative) return;
      onChange(value ? (value.startsWith('-') ? value.slice(1) : `-${value}`) : '-');
      return;
    }
    if (key === '.') {
      if (value.includes('.') || decimals === 0) return;
      onChange(!value || value === '-' ? `${value}0.` : `${value}.`);
      return;
    }
    const fraction = value.split('.')[1];
    if (decimals !== undefined && fraction !== undefined && fraction.length >= decimals) return;
    onChange(`${value}${key}`);
  };

  const dockClass = `hmi-virtual-input__dock hmi-virtual-input__dock--${dockPosition}`;

  const parsed = parseFloat(value);
  const isOutOfRange =
    !isNaN(parsed) && ((min !== undefined && parsed < min) || (max !== undefined && parsed > max));
  const canApply = !isNaN(parsed) && !isOutOfRange;
  const hasRange = showRange && (min !== undefined || max !== undefined);
  const keyDisabled = (key: string) =>
    (key === '-' && !allowNegative) || (key === '.' && decimals === 0);

  return createPortal(
    <div className={dockClass}>
      <div className="hmi-virtual-input__panel hmi-virtual-input__panel--compact" ref={panelRef}>
        <div className="hmi-virtual-input__header">
          {title && <span className="hmi-virtual-input__title">{title}</span>}
          <CloseButton
            className="hmi-virtual-input__close"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
            label="Close numpad"
          />
        </div>
        {currentValue !== undefined && currentValue !== '' && (
          <div className="hmi-virtual-input__current">
            Current setpoint {currentValue}
            {unit && ` ${unit}`}
          </div>
        )}
        <div
          className={`hmi-virtual-input__value${isOutOfRange ? ' hmi-virtual-input__value--invalid' : ''}`}
        >
          {value || (
            <span className="hmi-virtual-input__value-placeholder">{currentValue || '0'}</span>
          )}
          {unit && <span className="hmi-virtual-input__value-unit">{unit}</span>}
        </div>
        {hasRange && (
          <div className="hmi-virtual-input__range">
            {min !== undefined && `Min: ${min}`}
            {min !== undefined && max !== undefined && ' · '}
            {max !== undefined && `Max: ${max}`}
          </div>
        )}
        {isOutOfRange && (
          <div className="hmi-virtual-input__error" role="alert">
            {rangeMessage(min, max, unit)}
          </div>
        )}
        {NUMPAD_ROWS.map((row, rowIndex) => (
          <div
            className="hmi-virtual-input__row hmi-virtual-input__row--3"
            key={`numpad-row-${rowIndex}`}
          >
            {row.map((key) => (
              <button
                type="button"
                key={key}
                className="hmi-virtual-input__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyKey(key)}
                disabled={keyDisabled(key)}
                tabIndex={-1}
              >
                {key}
              </button>
            ))}
          </div>
        ))}
        <div className="hmi-virtual-input__row hmi-virtual-input__row--3 hmi-virtual-input__row--actions">
          <button
            type="button"
            className="hmi-virtual-input__key"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value.slice(0, -1))}
            tabIndex={-1}
          >
            Back
          </button>
          <button
            type="button"
            className="hmi-virtual-input__key"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange('')}
            tabIndex={-1}
          >
            Clear
          </button>
          <button
            type="button"
            className="hmi-virtual-input__key hmi-virtual-input__key--accent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (canApply) onApply(value);
            }}
            disabled={!canApply}
            tabIndex={-1}
          >
            Enter
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
