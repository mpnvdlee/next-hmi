import './style.css';
import { useRef, useLayoutEffect, useState, useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';

interface MenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

interface ItemProps {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}

interface SubmenuProps {
  label: string;
  children: ReactNode;
}

export function ContextMenu({ x, y, onClose, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(ref, onClose);

  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({
    top: y,
    left: x,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      top: y + h > vh ? Math.max(0, vh - h - 4) : y,
      left: x + w > vw ? Math.max(0, vw - w - 4) : x,
      ready: true,
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="cfg-context-menu"
      style={
        {
          top: pos.top,
          left: pos.left,
          visibility: pos.ready ? 'visible' : 'hidden',
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

export function ContextMenuItem({ children, onClick, danger = false }: ItemProps) {
  return (
    <button
      className={`cfg-context-menu__item${danger ? ' cfg-context-menu__item--danger' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="cfg-context-menu__separator" />;
}

export function ContextSubmenu({ label, children }: SubmenuProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [subStyle, setSubStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapperRef.current;
    const sub = subRef.current;
    if (!wrap || !sub) return;
    const wr = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const subW = sub.offsetWidth;
    const subH = sub.offsetHeight;

    const flipLeft = wr.right + subW > vw && wr.left >= subW;
    const maxH = Math.max(120, vh - 8);
    const cappedH = Math.min(subH, maxH);

    let top = -2;
    if (wr.top + top + cappedH > vh - 4) top = vh - 4 - cappedH - wr.top;
    if (wr.top + top < 4) top = 4 - wr.top;

    setSubStyle({
      top,
      ...(flipLeft ? { right: '100%', left: 'auto' } : { left: '100%', right: 'auto' }),
      maxHeight: maxH,
      overflowY: cappedH < subH ? 'auto' : 'visible',
    });
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const handleEnter = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };

  const handleLeave = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 120);
  };

  return (
    <div
      ref={wrapperRef}
      className="cfg-context-menu__sub-wrapper"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="cfg-context-menu__item cfg-context-menu__item--has-sub">
        {label}
        <span className="cfg-context-menu__sub-arrow">▶</span>
      </div>
      <div
        ref={subRef}
        className={`cfg-context-submenu${open ? ' cfg-context-submenu--open' : ''}`}
        style={subStyle}
      >
        {children}
      </div>
    </div>
  );
}

export function ContextItemIcon({ children }: { children: ReactNode }) {
  return <span className="cfg-context-menu__item-icon">{children}</span>;
}

export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return <div className="cfg-context-menu__label">{children}</div>;
}
