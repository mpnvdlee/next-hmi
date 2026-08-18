import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import { useReactiveEval } from '@hmi/hooks/useReactiveEval';
import type { ShellRegionConfig, ShellRegionId, VarSource } from '@shared/types/config';
import { bindingParts } from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import styles from './index.module.css';

interface Props {
  id: ShellRegionId;
  config: ShellRegionConfig;
  children?: ReactNode;
  /** Outline the region with `hmi-area--focus` (used by the editor preview). */
  focused?: boolean;
}

const VERTICAL: ReadonlySet<ShellRegionId> = new Set(['leftSidebar', 'rightSidebar']);

/** Evaluated length/color values arrive as whatever their source produced —
 *  coerce to a usable CSS string, treating empty/nullish as "not set". */
function cssString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : String(value);
  return text.trim() === '' ? undefined : text;
}

function resolveRegionSize(
  expandedSize: string | undefined,
  collapsedSize: string | undefined,
  expanded: boolean,
  isVertical: boolean,
): string {
  const candidate = expanded ? expandedSize : collapsedSize;
  if (candidate) return candidate;
  if (expanded) return 'auto';
  return isVertical ? '0' : 'auto';
}

export default function ShellRegion({ id, config, children, focused }: Props) {
  // Rendered outside the widget tree (no WidgetRenderer subscription), so
  // subscribe directly to any `$var` / `$time` driving the bindable region props.
  const evalCtx = useReactiveEval(
    config.expanded,
    config.overlay,
    config.enabled,
    config.expandedSize,
    config.collapsedSize,
    config.background,
  );
  const scope = useHmiScope();
  const regionRef = useRef<HTMLDivElement>(null);
  const [autoWidth, setAutoWidth] = useState<number | null>(null);

  const isVertical = VERTICAL.has(id);
  const enabledRaw = evaluatePropertyValue(config.enabled, evalCtx);
  const expandedRaw = evaluatePropertyValue(config.expanded, evalCtx);
  const expanded =
    expandedRaw === undefined || expandedRaw === null
      ? (config.defaultState ?? 'expanded') !== 'collapsed'
      : Boolean(expandedRaw);
  const expandedSize = cssString(evaluatePropertyValue(config.expandedSize, evalCtx));
  const collapsedSize = cssString(evaluatePropertyValue(config.collapsedSize, evalCtx));
  const background = cssString(evaluatePropertyValue(config.background, evalCtx));
  const size = resolveRegionSize(expandedSize, collapsedSize, expanded, isVertical);
  const wantsAutoSize = isVertical && size === 'auto';

  // `width: max-content` doesn't always recompute when grandchild widths change
  // (e.g. NavigationMenu collapsing) — measure with ResizeObserver and apply inline.
  useEffect(() => {
    if (!wantsAutoSize) {
      setAutoWidth(null);
      return;
    }
    const root = regionRef.current;
    if (!root) return;

    function findFirstSizedChild(parent: Element): HTMLElement | null {
      let cursor: Element | null = parent.firstElementChild;
      while (cursor) {
        if (window.getComputedStyle(cursor).display === 'contents') {
          cursor = cursor.firstElementChild;
          continue;
        }
        return cursor as HTMLElement;
      }
      return null;
    }

    let target: HTMLElement | null = findFirstSizedChild(root);
    if (!target) return;

    const measure = () => {
      if (!target) return;
      const w = target.offsetWidth;
      if (w > 0) setAutoWidth(w);
    };

    measure();

    const resizeObs = new ResizeObserver(measure);
    resizeObs.observe(target);
    // childList only — re-target on content swaps; ResizeObserver covers the rest.
    const mutObs = new MutationObserver(() => {
      const next = findFirstSizedChild(root);
      if (!next || next === target) return;
      resizeObs.disconnect();
      target = next;
      resizeObs.observe(target);
      measure();
    });
    mutObs.observe(root, { childList: true });

    return () => {
      resizeObs.disconnect();
      mutObs.disconnect();
    };
  }, [wantsAutoSize]);

  // Unset stays enabled; anything that evaluates falsy (static `false` or a
  // binding resolving to 0 / '' / false) takes the region out of the layout.
  if (enabledRaw !== undefined && enabledRaw !== null && !enabledRaw) return null;

  const defaultState = config.defaultState ?? 'expanded';
  if (defaultState === 'hidden' && config.expanded === undefined) return null;

  const overlay = Boolean(evaluatePropertyValue(config.overlay, evalCtx));

  const hasContent = children !== undefined && children !== null && children !== false;
  if (!hasContent) return null;

  if (overlay) {
    if (!expanded) return null;
    return (
      <OverlayLayer
        id={id}
        isVertical={isVertical}
        expandedSize={expandedSize ?? (isVertical ? '240px' : 'auto')}
        background={background}
        onDismiss={() => writeBoundFalse(config.expanded, scope)}
      >
        {children}
      </OverlayLayer>
    );
  }

  const sizeValue = size === 'auto' ? 'max-content' : size;
  const widthValue = wantsAutoSize && autoWidth !== null ? `${autoWidth}px` : sizeValue;

  const style: CSSWithVars = isVertical
    ? { width: widthValue, flexShrink: 0, overflow: size === '0' ? 'hidden' : undefined }
    : { height: sizeValue, flexShrink: 0, overflow: size === '0' ? 'hidden' : undefined };
  if (background) style['--hmi-region-bg'] = background;

  return (
    <div
      ref={regionRef}
      className={
        `${styles.region} ${styles[`region-${id}`] ?? ''}` + (focused ? ' hmi-area--focus' : '')
      }
      data-region={id}
      data-collapsed={!expanded ? 'true' : 'false'}
      style={style}
    >
      {children}
    </div>
  );
}

// ── Overlay layer (portal + backdrop) ─────────────────────────────────────────

function overlayPanelEdge(
  id: ShellRegionId,
  isVertical: boolean,
  expandedSize: string,
): CSSProperties {
  if (id === 'leftSidebar' && isVertical) {
    return { top: 0, bottom: 0, left: 0, width: expandedSize };
  }
  if (id === 'rightSidebar' && isVertical) {
    return { top: 0, bottom: 0, right: 0, width: expandedSize };
  }
  if (id === 'header') {
    return { top: 0, left: 0, right: 0, height: expandedSize };
  }
  return { bottom: 0, left: 0, right: 0, height: expandedSize };
}

function OverlayLayer({
  id,
  isVertical,
  expandedSize,
  background,
  onDismiss,
  children,
}: {
  id: ShellRegionId;
  isVertical: boolean;
  expandedSize: string;
  background?: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const panelStyle: CSSWithVars = {
    position: 'fixed',
    zIndex: 130,
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
    transition: 'transform 0.2s ease',
    ...overlayPanelEdge(id, isVertical, expandedSize),
  };
  if (background) panelStyle['--hmi-region-bg'] = background;

  return createPortal(
    <>
      <div className={styles.backdrop} onClick={onDismiss} aria-hidden="true" />
      <div
        className={`${styles.region} ${styles[`region-${id}`] ?? ''} ${styles.overlay}`}
        data-region={id}
        data-overlay="true"
        style={panelStyle}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * If `expanded` reaches a $var binding (directly or nested inside $if / $switch),
 * write `false` to that variable to dismiss. Silently noop otherwise.
 */
function writeBoundFalse(expanded: unknown, scope: string): void {
  const v = findBoundVar(expanded);
  if (!v?.path) return;
  const { datasource, location } = bindingParts(v);
  if (!datasource || !location) return;
  sendWsMessage({
    type: 'write_field',
    scope,
    datasource,
    path: location,
    value: false,
  });
}

function findBoundVar(expr: unknown): VarSource['$var'] | null {
  if (!expr || typeof expr !== 'object') return null;
  const obj = expr as Record<string, unknown>;
  if (obj.$var) return obj.$var as VarSource['$var'];
  if (obj.$if) {
    const i = obj.$if as Record<string, unknown>;
    return findBoundVar(i.condition) ?? findBoundVar(i.true) ?? findBoundVar(i.false);
  }
  if (obj.$switch) {
    const s = obj.$switch as { value?: unknown; cases?: { then?: unknown }[]; default?: unknown };
    let found = findBoundVar(s.value);
    if (found) return found;
    for (const c of s.cases ?? []) {
      found = findBoundVar(c?.then);
      if (found) return found;
    }
    return findBoundVar(s.default);
  }
  return null;
}
