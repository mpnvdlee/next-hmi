import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CloseButton from './CloseButton';

type KeyWidth = '1' | '1-5' | '1-75' | '2' | '2-25' | '2-75' | '3' | '12';

type KeyboardKey =
  | { kind: 'char'; value: string; shifted?: string; width?: KeyWidth }
  | { kind: 'tab'; width: KeyWidth }
  | { kind: 'space'; width: KeyWidth }
  | { kind: 'backspace'; width: KeyWidth }
  | { kind: 'clear'; width: KeyWidth }
  | { kind: 'enter'; width: KeyWidth }
  | { kind: 'capsLock'; width: KeyWidth }
  | { kind: 'shift'; width: KeyWidth; side: 'left' | 'right' };

const KEYBOARD_ROWS: KeyboardKey[][] = [
  [
    { kind: 'char', value: '`', shifted: '~' },
    { kind: 'char', value: '1', shifted: '!' },
    { kind: 'char', value: '2', shifted: '@' },
    { kind: 'char', value: '3', shifted: '#' },
    { kind: 'char', value: '4', shifted: '$' },
    { kind: 'char', value: '5', shifted: '%' },
    { kind: 'char', value: '6', shifted: '^' },
    { kind: 'char', value: '7', shifted: '&' },
    { kind: 'char', value: '8', shifted: '*' },
    { kind: 'char', value: '9', shifted: '(' },
    { kind: 'char', value: '0', shifted: ')' },
    { kind: 'char', value: '-', shifted: '_' },
    { kind: 'char', value: '=', shifted: '+' },
    { kind: 'backspace', width: '2' },
  ],
  [
    { kind: 'tab', width: '1-5' },
    { kind: 'char', value: 'q' },
    { kind: 'char', value: 'w' },
    { kind: 'char', value: 'e' },
    { kind: 'char', value: 'r' },
    { kind: 'char', value: 't' },
    { kind: 'char', value: 'y' },
    { kind: 'char', value: 'u' },
    { kind: 'char', value: 'i' },
    { kind: 'char', value: 'o' },
    { kind: 'char', value: 'p' },
    { kind: 'char', value: '[', shifted: '{' },
    { kind: 'char', value: ']', shifted: '}' },
    { kind: 'char', value: '\\', shifted: '|', width: '1-5' },
  ],
  [
    { kind: 'capsLock', width: '1-75' },
    { kind: 'char', value: 'a' },
    { kind: 'char', value: 's' },
    { kind: 'char', value: 'd' },
    { kind: 'char', value: 'f' },
    { kind: 'char', value: 'g' },
    { kind: 'char', value: 'h' },
    { kind: 'char', value: 'j' },
    { kind: 'char', value: 'k' },
    { kind: 'char', value: 'l' },
    { kind: 'char', value: ';', shifted: ':' },
    { kind: 'char', value: "'", shifted: '"' },
    { kind: 'enter', width: '2-25' },
  ],
  [
    { kind: 'shift', width: '2-25', side: 'left' },
    { kind: 'char', value: 'z' },
    { kind: 'char', value: 'x' },
    { kind: 'char', value: 'c' },
    { kind: 'char', value: 'v' },
    { kind: 'char', value: 'b' },
    { kind: 'char', value: 'n' },
    { kind: 'char', value: 'm' },
    { kind: 'char', value: ',', shifted: '<' },
    { kind: 'char', value: '.', shifted: '>' },
    { kind: 'char', value: '/', shifted: '?' },
    { kind: 'shift', width: '2-75', side: 'right' },
  ],
  [
    { kind: 'clear', width: '3' },
    { kind: 'space', width: '12' },
  ],
];

function keyLabel(key: KeyboardKey): string {
  if (key.kind === 'tab') return 'Tab';
  if (key.kind === 'space') return 'Space';
  if (key.kind === 'backspace') return 'Backspace';
  if (key.kind === 'clear') return 'Clear';
  if (key.kind === 'enter') return 'Enter';
  if (key.kind === 'capsLock') return 'Caps Lock';
  if (key.kind === 'shift') return `Shift ${key.side}`;
  return key.value;
}

function keyWidth(key: KeyboardKey): KeyWidth {
  return key.width ?? '1';
}

function characterFor(key: Extract<KeyboardKey, { kind: 'char' }>, shift: boolean, caps: boolean) {
  if (/^[a-z]$/.test(key.value)) return shift !== caps ? key.value.toUpperCase() : key.value;
  return shift && key.shifted ? key.shifted : key.value;
}

function keyClassName(key: KeyboardKey, isPressed: boolean): string {
  const classes = ['hmi-virtual-input__key', `hmi-virtual-input__key--size-${keyWidth(key)}`];
  if (key.kind !== 'char' && key.kind !== 'space') classes.push('hmi-virtual-input__key--modifier');
  if (key.kind === 'enter') classes.push('hmi-virtual-input__key--accent');
  if (isPressed) classes.push('hmi-virtual-input__key--pressed');
  return classes.join(' ');
}

interface VirtualKeyboardProps {
  isOpen: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  /** Ref to the anchor element — clicks on it will not trigger close. */
  anchorRef?: { readonly current: Element | null };
  title?: string;
  /** Masks the value preview while preserving its character count. */
  password?: boolean;
}

export function VirtualKeyboard({
  isOpen,
  value,
  onChange,
  onClose,
  anchorRef,
  title,
  password = false,
}: VirtualKeyboardProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    setShift(false);
    setCapsLock(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !previewRef.current) return;
    previewRef.current.scrollLeft = previewRef.current.scrollWidth;
  }, [isOpen, value]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen) return null;

  const valueLength = Array.from(value).length;
  const previewValue = password ? '•'.repeat(valueLength) : value;

  const applyKey = (key: KeyboardKey) => {
    if (key.kind === 'shift') {
      setShift((current) => !current);
      return;
    }
    if (key.kind === 'capsLock') {
      setCapsLock((current) => !current);
      return;
    }
    if (key.kind === 'enter') {
      onClose();
      return;
    }

    let next: string;
    if (key.kind === 'backspace') next = value.slice(0, -1);
    else if (key.kind === 'clear') next = '';
    else if (key.kind === 'space') next = `${value} `;
    else if (key.kind === 'tab') next = `${value}\t`;
    else next = `${value}${characterFor(key, shift, capsLock)}`;

    if (shift) setShift(false);
    onChange(next);
  };

  return createPortal(
    <div className="hmi-virtual-input__dock hmi-virtual-input__dock--center">
      <div
        className="hmi-virtual-input__panel hmi-virtual-input__panel--keyboard"
        ref={panelRef}
        role="group"
        aria-label={title ?? 'Keyboard'}
      >
        <div className="hmi-virtual-input__header">
          {title && <span className="hmi-virtual-input__title">{title}</span>}
          <CloseButton
            className="hmi-virtual-input__close"
            label="Close keyboard"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          />
        </div>
        <div
          className="hmi-virtual-input__value hmi-virtual-input__value--keyboard"
          ref={previewRef}
          aria-label={password ? `Password value, ${valueLength} characters` : 'Keyboard value'}
          aria-live="polite"
        >
          {previewValue || '\u00a0'}
        </div>
        {KEYBOARD_ROWS.map((row, rowIndex) => (
          <div
            className="hmi-virtual-input__row hmi-virtual-input__row--keyboard"
            key={`kb-row-${rowIndex}`}
          >
            {row.map((key, keyIndex) => {
              const isPressed =
                (key.kind === 'shift' && shift) || (key.kind === 'capsLock' && capsLock);
              const label =
                key.kind === 'char' ? characterFor(key, shift, capsLock) : keyLabel(key);

              return (
                <button
                  type="button"
                  key={`${key.kind}-${key.kind === 'char' ? key.value : keyIndex}`}
                  className={keyClassName(key, isPressed)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyKey(key)}
                  aria-label={label}
                  aria-pressed={
                    key.kind === 'shift' || key.kind === 'capsLock' ? isPressed : undefined
                  }
                  tabIndex={-1}
                >
                  {key.kind === 'char' && key.shifted ? (
                    <span className="hmi-virtual-input__key-legends" aria-hidden="true">
                      <span
                        className={`hmi-virtual-input__key-legend${shift ? ' hmi-virtual-input__key-legend--active' : ''}`}
                      >
                        {key.shifted}
                      </span>
                      <span
                        className={`hmi-virtual-input__key-legend${shift ? '' : ' hmi-virtual-input__key-legend--active'}`}
                      >
                        {key.value}
                      </span>
                    </span>
                  ) : (
                    <span aria-hidden="true">{label}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
