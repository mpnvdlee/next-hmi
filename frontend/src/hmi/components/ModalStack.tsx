import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
}: {
  anchored: boolean;
  placement: OverlayPlacement | undefined;
  size: OverlaySize | undefined;
}): string {
  const sizeClass = size && size !== 'auto' ? ` hmi-modal--size-${size}` : '';
  if (anchored) return `hmi-modal hmi-modal--overlay hmi-modal--anchored${sizeClass}`;
  const effectivePlacement = resolveEffectivePlacement(placement, false);
  // Unsized, centered cards stay in-flow inside .hmi-modal-stack (so multiple
  // tile via flexbox instead of overlapping); anything else docks to the
  // backdrop like a positioned overlay.
  if (effectivePlacement === 'center' && (!size || size === 'auto')) return 'hmi-modal';
  return `hmi-modal hmi-modal--overlay hmi-modal--placement-${effectivePlacement}${sizeClass}`;
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
  return {
    showCloseButton: !own || target.showCloseButton !== false,
    closeOnBackgroundPress: !own || target.closeOnBackgroundPress !== false,
  };
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

  const dim = openPageOverlays.some(({ entry }) => (entry.backdrop ?? 'dim') === 'dim');

  if (openPageOverlays.length === 0) return null;

  return (
    <div
      className={`hmi-modal-backdrop${dim ? '' : ' hmi-modal-backdrop--transparent'}`}
      onClick={() => {
        const top = openPageOverlays[openPageOverlays.length - 1];
        if (top && closeSettings(top.root, top.target).closeOnBackgroundPress) {
          closePageOverlay(top.entry.pageId);
        }
      }}
    >
      <div className="hmi-modal-stack">
        {openPageOverlays.map(
          ({ entry, node: overlayNode, page: activePage, root, rootNodes, target }, index) => {
            const anchored = isAnchoredPlacement(entry.placement) && Boolean(entry.anchorRect);
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
              }),
              style: { ...fixedStyle, ...stackOffsetStyle(stackIndex) },
              zIndex: index + 1,
              title: resolvePageTitle(target.title),
              onClose: closeSettings(root, target).showCloseButton
                ? () => closePageOverlay(entry.pageId)
                : null,
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
 * close button) over a content body, inside a `ModalCard`.
 */
function renderModalCard({
  key,
  anchorRect,
  placement,
  className,
  style,
  zIndex,
  title,
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
    >
      <div className="hmi-modal__header">
        <span className="hmi-modal__title">{title}</span>
        {onClose && <CloseButton className="hmi-modal__close" onClick={onClose} />}
      </div>
      <div className="hmi-modal__content" data-flow-direction="row" data-flow-align="stretch">
        {children}
      </div>
    </ModalCard>
  );
}

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
  children,
}: {
  anchorRect?: AnchorRect | null;
  placement?: OverlayPlacement;
  className: string;
  style?: CSSProperties;
  zIndex: number;
  children: ReactNode;
}) {
  const anchored = anchorRect != null && isAnchoredPlacement(placement);
  const [ref, pos] = useAnchoredStyle(anchored ? anchorRect : null, anchored ? placement : null);
  return (
    <div
      ref={ref}
      className={className}
      style={{ ...style, ...pos, zIndex }}
      onClick={(e) => e.stopPropagation()}
    >
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
