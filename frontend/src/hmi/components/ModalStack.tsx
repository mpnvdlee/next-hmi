import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import CloseButton from '@shared/components/CloseButton';
import type {
  AnchorRect,
  OverlayPlacement,
  OverlaySize,
  PageNode,
  PageRoot,
} from '@shared/types/config';
import { useHmiStore } from '@hmi/store/hmiStore';
import { resolvePageTitle } from '@shared/utils/pageTree';
import { isAnchoredPlacement } from '@shared/utils/anchorPosition';
import { useAnchoredStyle } from '@shared/hooks/useAnchoredStyle';
import { InputScopeContext } from '@hmi/context/InputScopeContext';
import { useResolvedPageOverlays } from '@hmi/hooks/useOpenOverlays';
import { PageDataSettleGate } from './DataSettleGate';
import PageGroupPageView from './PageGroupPageView';

/** Distance (px) between successive same-placement docked cards, so opening a
 *  second overlay at the same edge doesn't render pixel-for-pixel on top of
 *  the first. */
const STACK_OFFSET_STEP = 16;

/**
 * A trigger-relative placement with no captured anchor rect (e.g. the action
 * fired from a context with no trigger element, such as a global event or an
 * alert-modal replay) has nothing to anchor to — fall back to a plain
 * centered card rather than emitting a placement class that doesn't exist.
 */
function resolveEffectivePlacement(
  placement: OverlayPlacement | undefined,
  anchored: boolean,
): OverlayPlacement {
  if (anchored) return placement!;
  if (placement && isAnchoredPlacement(placement)) return 'center';
  return placement ?? 'center';
}

/**
 * Builds the modal card's className from its resolved anchoring/placement/size,
 * so the docking behavior — and the trigger-without-anchor fallback above —
 * stays in one place.
 */
function buildModalClassName({
  anchored,
  placement,
  size,
  draggable,
}: {
  anchored: boolean;
  placement: OverlayPlacement | undefined;
  size: OverlaySize | undefined;
  draggable: boolean;
}): string {
  const sizeClass = size && size !== 'auto' ? ` hmi-modal--size-${size}` : '';
  const dragClass = draggable ? ' hmi-modal--draggable' : '';
  if (anchored) return `hmi-modal hmi-modal--overlay hmi-modal--anchored${sizeClass}${dragClass}`;
  const effectivePlacement = resolveEffectivePlacement(placement, false);
  // Unsized, centered cards stay in-flow inside .hmi-modal-stack (so multiple
  // tile via flexbox instead of overlapping); anything else docks to the
  // backdrop like a positioned overlay. A draggable card docks too: the
  // scrolling stack would clip one dragged past its edge.
  if (effectivePlacement === 'center' && (!size || size === 'auto') && !draggable) {
    return 'hmi-modal';
  }
  return `hmi-modal hmi-modal--overlay hmi-modal--placement-${effectivePlacement}${sizeClass}${dragClass}`;
}

/**
 * CSS custom property that nudges a docked (non-anchored, non-center) card
 * away from the backdrop edge, so a second card opened at the same placement
 * doesn't render pixel-for-pixel on top of the first. Consumed by the
 * `.hmi-modal--placement-*` rules in hmi.css.
 */
function stackOffsetStyle(index: number): CSSProperties | undefined {
  if (index <= 0) return undefined;
  return { '--hmi-modal-stack-offset': `${index * STACK_OFFSET_STEP}px` } as CSSProperties;
}

/**
 * The close settings of an overlay's card. They belong to the node the action
 * named, and only a Dialogs-folder node carries them: an ordinary page borrowed
 * as an overlay always closes both ways.
 */
function closeSettings(root: PageRoot, target: PageNode) {
  const own = root === 'dialogs';
  // A dialog that leaves the screen usable has no backdrop to press.
  const modeless = own && target.modeless === true;
  return {
    showCloseButton: !own || target.showCloseButton !== false,
    closeOnBackgroundPress: !modeless && (!own || target.closeOnBackgroundPress !== false),
    tapThrough: !own || target.tapThrough !== false,
    draggable: own && target.draggable === true,
    modeless,
  };
}

/** Hands a backdrop press on to the topmost element under it that is not part
 *  of the overlay stack. */
function passPressThrough(backdrop: Element, x: number, y: number) {
  const beneath = document.elementsFromPoint(x, y).find((el) => !backdrop.contains(el));
  if (!beneath) return;
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
  // Button and Container act on pointer-down and -up; native controls on click.
  beneath.dispatchEvent(new PointerEvent('pointerdown', init));
  beneath.dispatchEvent(new PointerEvent('pointerup', init));
  beneath.dispatchEvent(new MouseEvent('click', init));
}

/**
 * Renders the modal backdrop with the page-overlay stack, in the order the
 * overlays opened — the last one is on top and is the one the backdrop acts on.
 * Shared between HmiView and PreviewView.
 */
export function ModalStack() {
  const closePageOverlay = useHmiStore((s) => s.closePageOverlay);
  const updatePageOverlay = useHmiStore((s) => s.updatePageOverlay);

  const openPageOverlays = useResolvedPageOverlays();

  // Tracks how many docked cards already claim a given placement (in render
  // order) so a second card at the same edge renders offset from the first
  // instead of directly on top of it. In-flow centered cards and anchored
  // popovers don't collide by construction, so they never consume a slot.
  const placementStackCounts = new Map<OverlayPlacement, number>();
  function stackIndexFor(
    anchored: boolean,
    placement: OverlayPlacement | undefined,
    size: OverlaySize | undefined,
  ): number {
    if (anchored) return 0;
    const effective = resolveEffectivePlacement(placement, false);
    if (effective === 'center' && (!size || size === 'auto')) return 0;
    const n = placementStackCounts.get(effective) ?? 0;
    placementStackCounts.set(effective, n + 1);
    return n;
  }

  const settingsOf = (o: { root: PageRoot; target: PageNode }) => closeSettings(o.root, o.target);
  const dim = openPageOverlays.some(
    (o) => !settingsOf(o).modeless && (o.entry.backdrop ?? 'dim') === 'dim',
  );
  // One modal dialog still blocks the screen; only all-modeless leaves it usable.
  const modeless = openPageOverlays.every((o) => settingsOf(o).modeless);

  if (openPageOverlays.length === 0) return null;

  return (
    <div
      className={`hmi-modal-backdrop${dim ? '' : ' hmi-modal-backdrop--transparent'}${
        modeless ? ' hmi-modal-backdrop--modeless' : ''
      }`}
      onClick={(e) => {
        const top = openPageOverlays[openPageOverlays.length - 1];
        if (!top) return;
        const settings = closeSettings(top.root, top.target);
        if (!settings.closeOnBackgroundPress) return;
        closePageOverlay(top.entry.pageId);
        // With no backdrop drawn, the press was aimed at what lies under it.
        if (!dim && settings.tapThrough) passPressThrough(e.currentTarget, e.clientX, e.clientY);
      }}
    >
      <div className="hmi-modal-stack">
        {openPageOverlays.map(
          ({ entry, node: overlayNode, page: activePage, root, rootNodes, target }, index) => {
            const anchored = isAnchoredPlacement(entry.placement) && Boolean(entry.anchorRect);
            const settings = closeSettings(root, target);
            const showHeader = target.showModalHeader !== false;
            // The header bar is the handle, so a card without one stays put.
            const draggable = settings.draggable && showHeader;
            const stackIndex = stackIndexFor(anchored, entry.placement, entry.size);
            const fixedStyle =
              entry.size === 'fixed'
                ? { width: entry.width ?? 400, height: entry.height ?? 300 }
                : undefined;
            return renderModalCard({
              key: `overlay-page-${entry.pageId}`,
              anchorRect: anchored ? entry.anchorRect : null,
              placement: entry.placement,
              className: buildModalClassName({
                anchored,
                placement: entry.placement,
                size: entry.size,
                draggable,
              }),
              style: { ...fixedStyle, ...stackOffsetStyle(stackIndex) },
              zIndex: index + 1,
              // The header bar is the named node's, from either root — a group
              // opened as an overlay decides it, not the page shown inside it.
              title: resolvePageTitle(target.title),
              showHeader,
              draggable,
              modeless: settings.modeless,
              onClose: settings.showCloseButton ? () => closePageOverlay(entry.pageId) : null,
              children: (
                <PageOverlayBody
                  rootNodes={rootNodes}
                  takesInputs={root === 'dialogs'}
                  requestedId={overlayNode.id}
                  activePageId={activePage?.id}
                  componentProperties={entry.componentProperties}
                  onNavigate={(pageId, replace) => {
                    // A `replace` call is `PageGroupPageView` canonicalising a group
                    // id to its first child — meaningful for a URL, not for an
                    // overlay, whose own resolution already falls back the same way.
                    // Honouring it would move the entry off the group the action
                    // named, so `closePageOverlay` could no longer close by it.
                    if (!replace) updatePageOverlay(entry.pageId, pageId);
                  }}
                />
              ),
            });
          },
        )}
      </div>
    </div>
  );
}

/**
 * The modal-card shape every page overlay shares: a header (title + optional
 * close button) over a content body, inside a `ModalCard`. With `showHeader`
 * off the header bar goes, close button included.
 */
function renderModalCard({
  key,
  anchorRect,
  placement,
  className,
  style,
  zIndex,
  title,
  showHeader,
  draggable,
  modeless,
  onClose,
  children,
}: {
  key: string;
  anchorRect?: AnchorRect | null;
  placement?: OverlayPlacement;
  className: string;
  style?: CSSProperties;
  zIndex: number;
  title: string;
  showHeader: boolean;
  draggable: boolean;
  modeless: boolean;
  onClose: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <ModalCard
      key={key}
      anchorRect={anchorRect}
      placement={placement}
      className={className}
      style={style}
      zIndex={zIndex}
      modeless={modeless}
      header={
        showHeader
          ? (dragProps: DragHandleProps) => (
              <div className="hmi-modal__header" {...(draggable ? dragProps : undefined)}>
                <span className="hmi-modal__title">{title}</span>
                {onClose && <CloseButton className="hmi-modal__close" onClick={onClose} />}
              </div>
            )
          : null
      }
    >
      <div className="hmi-modal__content" data-flow-direction="row" data-flow-align="stretch">
        {children}
      </div>
    </ModalCard>
  );
}

type DragHandleProps = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
};

/**
 * A modal card. When `anchorRect` is supplied and the placement is a `trigger-*`
 * popover, it renders at the raw offset, then measures itself and repositions
 * clamped into the viewport; otherwise it renders as a plain (CSS-placed) card.
 */
function ModalCard({
  anchorRect,
  placement,
  className,
  style,
  zIndex,
  modeless,
  header,
  children,
}: {
  anchorRect?: AnchorRect | null;
  placement?: OverlayPlacement;
  className: string;
  style?: CSSProperties;
  zIndex: number;
  modeless: boolean;
  /** The header bar, handed the props that drag the card by it. */
  header: ((dragProps: DragHandleProps) => ReactNode) | null;
  children: ReactNode;
}) {
  const anchored = anchorRect != null && isAnchoredPlacement(placement);
  const [ref, pos] = useAnchoredStyle(anchored ? anchorRect : null, anchored ? placement : null);
  // Where the card was dragged to, kept while it stays open.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // The pointer and offset at the grab, and how far the header may move each way.
  const grab = useRef<{
    x: number;
    y: number;
    from: { x: number; y: number };
    box: DOMRect;
  } | null>(null);
  const release = () => {
    grab.current = null;
  };
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const dragProps: DragHandleProps = {
    onPointerDown: (e) => {
      if ((e.target as Element).closest('.hmi-modal__close')) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const box = e.currentTarget.getBoundingClientRect();
      grab.current = { x: e.clientX, y: e.clientY, from: offset, box };
    },
    onPointerMove: (e) => {
      if (!grab.current) return;
      const { x, y, from, box } = grab.current;
      // The whole header bar, close button included, stays on screen.
      const dx = clamp(e.clientX - x, -box.left, window.innerWidth - box.right);
      const dy = clamp(e.clientY - y, -box.top, window.innerHeight - box.bottom);
      setOffset({ x: from.x + dx, y: from.y + dy });
    },
    onPointerUp: release,
    onPointerCancel: release,
  };
  const dragStyle = {
    '--hmi-modal-drag-x': `${offset.x}px`,
    '--hmi-modal-drag-y': `${offset.y}px`,
  } as CSSProperties;
  return (
    <div
      ref={ref}
      className={className}
      style={{ ...style, ...pos, ...dragStyle, zIndex }}
      role="dialog"
      aria-modal={!modeless}
      onClick={(e) => e.stopPropagation()}
    >
      {header?.(dragProps)}
      {children}
    </div>
  );
}

function PageOverlayBody({
  rootNodes,
  takesInputs,
  requestedId,
  activePageId,
  componentProperties,
  onNavigate,
}: {
  /** The page-tree root the overlay's node lives in. */
  rootNodes: PageNode[];
  /** Whether that node takes input parameters — only the Dialogs folder's do. */
  takesInputs: boolean;
  /** The node the overlay shows — may be a page group. */
  requestedId: string;
  /** The leaf page under it, which is what the backend acks. */
  activePageId: string | undefined;
  componentProperties: Record<string, unknown>;
  onNavigate: (pageId: string, replace?: boolean) => void;
}) {
  // Only the values the action supplied. Declared defaults are layered in by
  // `PageGroupPageView`, which is the only place that knows the whole group
  // trail — folding them in here would make the outermost declaration win. A
  // node outside the Dialogs folder takes no inputs, so it gets no scope at all.
  const scope = useMemo(
    () => (takesInputs ? { properties: componentProperties } : null),
    [takesInputs, componentProperties],
  );
  // Outside the settle gate and the page view so a page-group's header/footer
  // chrome reads the overlay's values too, not just the page body.
  return (
    <InputScopeContext.Provider value={scope}>
      {/* An overlay's *resolved page* id is sent in `set_context`'s
          `currentPageIds` (HmiView), so `context_ready` echoes it back and the
          overlay gets a real settle signal of its own — it does not inherit the
          host page's, which is already closed by the time the overlay opens. A
          targeted page group has no id the backend knows, so the gate keys off
          the page inside it rather than waiting forever on an ack for the
          group. */}
      <PageDataSettleGate pageId={activePageId}>
        <PageGroupPageView
          pages={rootNodes}
          requestedId={requestedId}
          onNavigate={onNavigate}
          takesInputs={takesInputs}
        />
      </PageDataSettleGate>
    </InputScopeContext.Provider>
  );
}
