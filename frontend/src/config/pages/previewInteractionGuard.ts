import { NO_MODIFIERS, selectionModifiers, type SelectionModifiers } from '@shared/utils/domEvent';

const BLOCKED_EVENTS = [
  'pointerdown',
  'mousedown',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'dragstart',
  'drop',
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'change',
  'submit',
] as const;

/** Events handled by a dedicated listener below instead of the plain blocker. */
const SPECIAL_EVENTS = new Set<string>(['pointerdown', 'contextmenu']);

type SelectTarget = (target: Element, mods: SelectionModifiers) => void;
type RequestContextMenu = (target: Element, x: number, y: number) => void;

/**
 * Disable operator interaction throughout the preview document while the
 * editor is in config mode.
 *
 * This deliberately lives above individual widgets. A document capture
 * listener runs before widget handlers and also covers UI rendered through a
 * portal (virtual keyboards, navigation flyouts, shell overlays, and modals).
 * Wheel/scroll and hover are left alone so the preview remains inspectable.
 */
export function installPreviewInteractionGuard(
  doc: Document,
  selectTarget: SelectTarget,
  requestContextMenu?: RequestContextMenu,
): () => void {
  const block = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const selectAndBlock = (event: Event) => {
    // SVG and canvas-backed widgets can surface a non-HTMLElement Element.
    if (event.target instanceof Element) {
      // A synthetic dispatch (jsdom, some assistive tech) arrives as a plain Event
      // with no modifier state at all — treat that as a plain click.
      selectTarget(
        event.target,
        event instanceof MouseEvent ? selectionModifiers(event) : NO_MODIFIERS,
      );
    }
    block(event);
  };

  // The native menu stays suppressed; the editor parent renders its own menu at
  // the reported position instead.
  const reportContextMenuAndBlock = (event: Event) => {
    if (requestContextMenu && event instanceof MouseEvent && event.target instanceof Element) {
      requestContextMenu(event.target, event.clientX, event.clientY);
    }
    block(event);
  };

  const blockFocus = (event: Event) => {
    // focusin is not cancelable. Blur first so programmatic focus and a field
    // left focused when switching from test mode cannot accept keyboard input.
    if (event.target instanceof HTMLElement) event.target.blur();
    block(event);
  };

  const activeElement = doc.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== doc.body) {
    activeElement.blur();
  }

  doc.addEventListener('pointerdown', selectAndBlock, true);
  doc.addEventListener('contextmenu', reportContextMenuAndBlock, true);
  for (const type of BLOCKED_EVENTS) {
    if (!SPECIAL_EVENTS.has(type)) doc.addEventListener(type, block, true);
  }
  doc.addEventListener('focusin', blockFocus, true);

  return () => {
    doc.removeEventListener('pointerdown', selectAndBlock, true);
    doc.removeEventListener('contextmenu', reportContextMenuAndBlock, true);
    for (const type of BLOCKED_EVENTS) {
      if (!SPECIAL_EVENTS.has(type)) doc.removeEventListener(type, block, true);
    }
    doc.removeEventListener('focusin', blockFocus, true);
  };
}
