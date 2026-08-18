import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import CloseButton from '@shared/components/CloseButton';
import type {
  AnchorRect,
  DialogConfig,
  OverlayPlacement,
  OverlaySize,
  WidgetConfig,
} from '@shared/types/config';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { resolvePageTitle } from '@shared/utils/pageTree';
import { isAnchoredPlacement } from '@shared/utils/anchorPosition';
import { useAnchoredStyle } from '@shared/hooks/useAnchoredStyle';
import { InputScopeContext } from '@hmi/context/InputScopeContext';
import { useResolvedDialogs, useResolvedPageOverlays } from '@hmi/hooks/useOpenOverlays';
import WidgetRenderer from './WidgetRenderer';
import PageGroupPageView from './PageGroupPageView';

/** Distance (px) between successive same-placement docked cards, so opening a
 *  second dialog/overlay at the same edge doesn't render pixel-for-pixel on
 *  top of the first. */
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
 * Builds the modal card's className from its resolved anchoring/placement/size.
 * Shared by both dialogs and page overlays so their docking behavior — and the
 * trigger-without-anchor fallback above — stays in one place.
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
 * Renders the modal backdrop with page-overlay and dialog stacks.
 * Shared between HmiView and PreviewView.
 */
export function ModalStack() {
  // Still needed directly: PageGroupPageView (for page overlays) resolves its
  // own page-group chrome stack from the full page tree, not just the
  // already-resolved overlay page.
  const pages = useConfigStore((s) => s.pages);
  const closeDialog = useHmiStore((s) => s.closeDialog);
  const closePageOverlay = useHmiStore((s) => s.closePageOverlay);
  const updatePageOverlay = useHmiStore((s) => s.updatePageOverlay);

  const openDialogs = useResolvedDialogs();
  const openPageOverlays = useResolvedPageOverlays();

  // Tracks how many docked cards already claim a given placement (across both
  // overlays and dialogs, in render order) so a second card at the same edge
  // renders offset from the first instead of directly on top of it. In-flow
  // centered cards and anchored popovers don't collide by construction, so
  // they never consume a slot.
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

  const dim =
    openPageOverlays.some(({ entry }) => (entry.backdrop ?? 'dim') === 'dim') ||
    openDialogs.some(({ entry }) => (entry.backdrop ?? 'dim') === 'dim');

  if (openDialogs.length === 0 && openPageOverlays.length === 0) return null;

  return (
    <div
      className={`hmi-modal-backdrop${dim ? '' : ' hmi-modal-backdrop--transparent'}`}
      onClick={() => {
        // Dialogs always render above page overlays (see zIndex below), so a
        // dialog — if any is open — is whichever the operator is actually
        // looking at; only fall back to closing the topmost page overlay when
        // no dialog is on top of it.
        const topDialog = openDialogs[openDialogs.length - 1]?.dialog;
        if (topDialog) {
          if (topDialog.closeOnBackgroundPress) {
            closeDialog(topDialog.id);
          }
          return;
        }
        const topItem = openPageOverlays[openPageOverlays.length - 1];
        if (topItem) {
          closePageOverlay(topItem.page.id);
        }
      }}
    >
      {openPageOverlays.map(({ entry, page: overlayPage }, index) => {
        const anchored = isAnchoredPlacement(entry.placement) && Boolean(entry.anchorRect);
        const stackIndex = stackIndexFor(anchored, entry.placement, entry.size);
        const fixedStyle =
          entry.size === 'fixed'
            ? { width: entry.width ?? 400, height: entry.height ?? 300 }
            : undefined;
        return renderModalCard({
          key: `overlay-page-${overlayPage.id}`,
          anchorRect: anchored ? entry.anchorRect : null,
          placement: entry.placement,
          className: buildModalClassName({
            anchored,
            placement: entry.placement,
            size: entry.size,
          }),
          style: { ...fixedStyle, ...stackOffsetStyle(stackIndex) },
          zIndex: index + 1,
          title: resolvePageTitle(overlayPage.title),
          onClose: () => closePageOverlay(overlayPage.id),
          children: (
            <PageGroupPageView
              pages={pages}
              requestedId={overlayPage.id}
              onNavigate={(pageId) => updatePageOverlay(overlayPage.id, pageId)}
            />
          ),
        });
      })}
      <div className="hmi-modal-stack">
        {openDialogs.map(({ dialog, entry }, index) => {
          const anchored = isAnchoredPlacement(entry.placement) && Boolean(entry.anchorRect);
          const stackIndex = stackIndexFor(anchored, entry.placement, entry.size);
          const fixedStyle =
            entry.size === 'fixed'
              ? { width: entry.width ?? 400, height: entry.height ?? 300 }
              : undefined;
          return renderModalCard({
            key: dialog.id,
            anchorRect: anchored ? entry.anchorRect : null,
            placement: entry.placement,
            className: buildModalClassName({
              anchored,
              placement: entry.placement,
              size: entry.size,
            }),
            style: { ...fixedStyle, ...stackOffsetStyle(stackIndex) },
            zIndex: openPageOverlays.length + index + 1,
            title: dialog.title,
            onClose: dialog.showCloseButton ? () => closeDialog(dialog.id) : null,
            children: (
              <DialogBody dialog={dialog} componentProperties={entry.componentProperties} />
            ),
          });
        })}
      </div>
    </div>
  );
}

/**
 * Shared modal-card shape for both dialogs and page overlays: a header (title
 * + optional close button) over a content body, inside a `ModalCard`.
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
      <div className="hmi-modal__content">{children}</div>
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

function DialogBody({
  dialog,
  componentProperties,
}: {
  dialog: DialogConfig;
  componentProperties: Record<string, unknown>;
}) {
  const scope = useMemo(() => ({ properties: componentProperties }), [componentProperties]);
  return (
    <InputScopeContext.Provider value={scope}>
      {(dialog.widgets as WidgetConfig[]).map((comp) => (
        <WidgetRenderer key={comp.id} node={comp} />
      ))}
    </InputScopeContext.Provider>
  );
}
