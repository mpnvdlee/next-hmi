import './style.css';
import { createPortal } from 'react-dom';
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { ChevronDownIcon } from '../actionIcons';

interface SelectOption {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
  group?: string;
  style?: CSSProperties;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Native <option> / <optgroup> elements, so call sites stay drop-in. */
  children: ReactNode;
  className?: string;
  /** Extra class on the portaled option list. The popup is sized from the
   *  trigger's box, so a compact trigger with long option labels needs its own
   *  hook to widen the list without widening the control. */
  popupClassName?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  style?: CSSProperties;
  placeholder?: string;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  'aria-label'?: string;
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

function parseOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (nodes: ReactNode, group?: string) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === 'option') {
        const p = child.props as {
          value?: string | number;
          children?: ReactNode;
          disabled?: boolean;
          style?: CSSProperties;
        };
        const text = nodeText(p.children);
        out.push({
          value: p.value === undefined ? text : String(p.value),
          label: p.children ?? text,
          text,
          disabled: Boolean(p.disabled),
          group,
          style: p.style,
        });
      } else if (child.type === 'optgroup') {
        const p = child.props as { label?: string; children?: ReactNode };
        walk(p.children, p.label);
      } else {
        const p = child.props as { children?: ReactNode };
        if (p && p.children) walk(p.children, group);
      }
    });
  };
  walk(children);
  return out;
}

/**
 * Config-styled single-select dropdown. Native <select> can't style its option
 * list (the popup is OS-drawn), so this renders a custom trigger + portaled
 * listbox that matches the rest of the config UI. It accepts native <option> /
 * <optgroup> children so existing call sites convert with minimal churn.
 */
export default function Select({
  value,
  onChange,
  children,
  className = '',
  popupClassName,
  disabled = false,
  id,
  title,
  style,
  placeholder,
  onClick,
  'aria-label': ariaLabel,
}: SelectProps) {
  const options = useMemo(() => parseOptions(children), [children]);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buffer: '', ts: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const firstEnabled = useCallback(
    (from: number, dir: 1 | -1) => {
      const n = options.length;
      if (n === 0) return -1;
      for (let step = 0; step < n; step++) {
        const i = (((from + dir * step) % n) + n) % n;
        if (!options[i].disabled) return i;
      }
      return -1;
    },
    [options],
  );

  // Write the popup position straight to the DOM rather than through React
  // state: on scroll we need it to track the trigger within the same frame, and
  // a state update would commit a frame late and make the popup visibly stutter.
  const reposition = useCallback(() => {
    const t = triggerRef.current;
    const p = popupRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    const margin = 8;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const below = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    // Cap to the room actually available on the chosen side so the list never
    // spills past the viewport edge.
    const maxHeight = Math.min(320, Math.max(0, below ? spaceBelow : spaceAbove));
    p.style.position = 'fixed';
    p.style.width = `${r.width}px`;
    p.style.maxHeight = `${maxHeight}px`;
    if (below) {
      p.style.top = `${r.bottom + 2}px`;
      p.style.bottom = 'auto';
    } else {
      p.style.bottom = `${window.innerHeight - r.top + 2}px`;
      p.style.top = 'auto';
    }
    // Clamp on the horizontal axis, mirroring the vertical cap above: a compact
    // trigger docked against the right of the window would put a wider popup
    // off-screen, and sliding it back is what right-aligns such a menu to its
    // trigger. Only a `popupClassName` stylesheet can widen the popup past the
    // `width` just written, so every other Select clamps against the trigger's
    // own width — this runs on capture-phase scroll, and reading `offsetWidth`
    // after those writes forces a synchronous layout on each event.
    const width = popupClassName ? p.offsetWidth : r.width;
    const room = window.innerWidth - margin - width;
    p.style.left = `${Math.max(margin, Math.min(r.left, room))}px`;
  }, [popupClassName]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => reposition();
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt) || popupRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    popupRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled(0, 1));
    setOpen(true);
  }, [disabled, selectedIndex, firstEnabled]);

  const choose = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      if (opt.value !== value) onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, value, onChange],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => firstEnabled((i < 0 ? -1 : i) + 1, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => firstEnabled((i < 0 ? 0 : i) - 1, -1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(firstEnabled(0, 1));
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(firstEnabled(options.length - 1, -1));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIndex >= 0) choose(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          const ta = typeahead.current;
          ta.buffer = now - ta.ts > 600 ? e.key : ta.buffer + e.key;
          ta.ts = now;
          const q = ta.buffer.toLowerCase();
          const start = activeIndex >= 0 ? activeIndex : 0;
          const n = options.length;
          for (let s = 1; s <= n; s++) {
            const i = (start + s) % n;
            if (!options[i].disabled && options[i].text.toLowerCase().startsWith(q)) {
              setActiveIndex(i);
              break;
            }
          }
        }
        break;
    }
  };

  const triggerCls = ['cfg-select', open && 'cfg-select--open', className]
    .filter(Boolean)
    .join(' ');
  const activeId = open && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        title={title}
        style={style}
        className={triggerCls}
        disabled={disabled}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        onClick={(e) => {
          onClick?.(e);
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={onKeyDown}
      >
        <span className="cfg-select__value">
          {selected ? (
            selected.label
          ) : (
            <span className="cfg-select__placeholder">{placeholder ?? ''}</span>
          )}
        </span>
        {/* Slot, not a bare glyph: inside a field group it takes the same
            bordered column geometry as the row's other trailing buttons (see
            FieldGroup/style.css). Standalone it adds nothing. */}
        <span className="cfg-select__chevron-slot">
          <ChevronDownIcon className="cfg-select__chevron" />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className={popupClassName ? `cfg-select-popup ${popupClassName}` : 'cfg-select-popup'}
          >
            {options.map((opt, i) => {
              const showGroup = opt.group && opt.group !== options[i - 1]?.group;
              const isSelected = opt.value === value;
              const cls = [
                'cfg-select-popup__option',
                i === activeIndex && 'cfg-select-popup__option--active',
                isSelected && 'cfg-select-popup__option--selected',
                opt.disabled && 'cfg-select-popup__option--disabled',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div key={`${opt.value}-${i}`}>
                  {showGroup && <div className="cfg-select-popup__group">{opt.group}</div>}
                  <div
                    id={`${baseId}-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    style={opt.style}
                    className={cls}
                    onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(i)}
                  >
                    {opt.label}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
