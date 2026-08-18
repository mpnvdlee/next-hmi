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
  /** Called on Enter, ×, or outside click. Receives the current value so consumers can commit in one step. */
  onClose: (value: string) => void;
  /** Ref to the anchor element — clicks on it will not trigger close. */
  anchorRef?: { readonly current: Element | null };
  title?: string;
  dockPosition?: 'center' | 'bottom-right';
  /** Range/unit hint shown under the title. Reddens the value preview and disables Enter when out of range. Omit to hide. */
  min?: number;
  max?: number;
  unit?: string;
}

export function VirtualNumpad({
  isOpen,
  value,
  onChange,
  onClose,
  anchorRef,
  title,
  dockPosition = 'bottom-right',
  min,
  max,
  unit,
}: VirtualNumpadProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose(value);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isOpen, value, onClose, anchorRef]);

  if (!isOpen) return null;

  const applyKey = (key: string) => {
    if (key === '-') {
      onChange(value ? (value.startsWith('-') ? value.slice(1) : `-${value}`) : '-');
      return;
    }
    if (key === '.') {
      if (value.includes('.')) return;
      onChange(!value || value === '-' ? `${value}0.` : `${value}.`);
      return;
    }
    onChange(`${value}${key}`);
  };

  const dockClass = `hmi-virtual-input__dock hmi-virtual-input__dock--${dockPosition}`;

  const parsed = parseFloat(value);
  const isInvalid =
    value !== '' &&
    value !== '-' &&
    !isNaN(parsed) &&
    ((min !== undefined && parsed < min) || (max !== undefined && parsed > max));
  const hasRange = min !== undefined || max !== undefined;

  return createPortal(
    <div className={dockClass}>
      <div className="hmi-virtual-input__panel hmi-virtual-input__panel--compact" ref={panelRef}>
        <div className="hmi-virtual-input__header">
          {title && <span className="hmi-virtual-input__title">{title}</span>}
          <CloseButton
            className="hmi-virtual-input__close"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onClose(value)}
            label="Close numpad"
          />
        </div>
        <div
          className={`hmi-virtual-input__value${isInvalid ? ' hmi-virtual-input__value--invalid' : ''}`}
        >
          {value || '0'}
          {unit && <span className="hmi-virtual-input__value-unit">{unit}</span>}
        </div>
        {hasRange && (
          <div className="hmi-virtual-input__range">
            {min !== undefined && `Min: ${min}`}
            {min !== undefined && max !== undefined && ' · '}
            {max !== undefined && `Max: ${max}`}
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
              if (isInvalid) return;
              onClose(value);
            }}
            disabled={isInvalid}
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
