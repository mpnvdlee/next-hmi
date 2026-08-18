import { render } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore, type DialogEntry } from '@hmi/store/hmiStore';
import type { DialogConfig } from '@shared/types/config';
import { ModalStack } from './ModalStack';

function makeDialog(id: string): DialogConfig {
  return { id, title: `Dialog ${id}`, widgets: [] };
}

function openDialogEntries(entries: DialogEntry[]) {
  useHmiStore.setState({ openDialogs: entries });
}

function cardFor(container: HTMLElement, dialogId: string): HTMLElement {
  // Cards render in DOM order matching openDialogs order; select by index via title text.
  const titles = Array.from(container.querySelectorAll('.hmi-modal__title'));
  const idx = titles.findIndex((t) => t.textContent === `Dialog ${dialogId}`);
  return Array.from(container.querySelectorAll('.hmi-modal'))[idx] as HTMLElement;
}

describe('ModalStack dialog placement/size', () => {
  beforeEach(() => {
    useConfigStore.setState({ dialogs: [makeDialog('a'), makeDialog('b')] });
    useHmiStore.setState({ openDialogs: [], openPageOverlays: [] });
  });

  it('renders a default (center, no size) dialog as a plain in-flow card', () => {
    openDialogEntries([{ id: 'a', componentProperties: {} }]);
    const { container } = render(<ModalStack />);
    const card = cardFor(container, 'a');
    expect(card.className).toBe('hmi-modal');
  });

  it('docks an edge-placed dialog to the backdrop with a placement class', () => {
    openDialogEntries([{ id: 'a', componentProperties: {}, placement: 'top' }]);
    const { container } = render(<ModalStack />);
    const card = cardFor(container, 'a');
    expect(card.className).toContain('hmi-modal--overlay');
    expect(card.className).toContain('hmi-modal--placement-top');
  });

  it('falls back to a centered card for a trigger placement with no captured anchor rect', () => {
    // e.g. fired from a global event / alert-modal replay, which has no trigger element.
    openDialogEntries([{ id: 'a', componentProperties: {}, placement: 'trigger-below' }]);
    const { container } = render(<ModalStack />);
    const card = cardFor(container, 'a');
    expect(card.className).toBe('hmi-modal');
  });

  it('applies a size class to an edge-docked dialog', () => {
    openDialogEntries([{ id: 'a', componentProperties: {}, placement: 'left', size: 'medium' }]);
    const { container } = render(<ModalStack />);
    const card = cardFor(container, 'a');
    expect(card.className).toContain('hmi-modal--size-medium');
  });

  it('offsets a second dialog docked at the same placement instead of overlapping it', () => {
    openDialogEntries([
      { id: 'a', componentProperties: {}, placement: 'top' },
      { id: 'b', componentProperties: {}, placement: 'top' },
    ]);
    const { container } = render(<ModalStack />);
    const cardA = cardFor(container, 'a');
    const cardB = cardFor(container, 'b');
    expect(cardA.style.getPropertyValue('--hmi-modal-stack-offset')).toBe('');
    expect(cardB.style.getPropertyValue('--hmi-modal-stack-offset')).toBe('16px');
  });
});
