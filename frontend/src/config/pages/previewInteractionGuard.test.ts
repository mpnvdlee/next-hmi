import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPreviewInteractionGuard } from './previewInteractionGuard';

describe('installPreviewInteractionGuard', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  it('selects a widget on pointer down without running widget handlers', () => {
    const widget = document.createElement('div');
    const select = document.createElement('select');
    widget.append(select);
    document.body.append(widget);

    const onSelect = vi.fn();
    const widgetHandler = vi.fn();
    select.addEventListener('pointerdown', widgetHandler);
    cleanup = installPreviewInteractionGuard(document, onSelect);

    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    select.dispatchEvent(event);

    expect(onSelect).toHaveBeenCalledWith(select, { toggle: false, range: false });
    expect(widgetHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('reports the toggle modifier of a ctrl/cmd pointer down', () => {
    const widget = document.createElement('div');
    document.body.append(widget);
    const onSelect = vi.fn();
    cleanup = installPreviewInteractionGuard(document, onSelect);

    widget.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, metaKey: true }),
    );

    expect(onSelect).toHaveBeenCalledWith(widget, { toggle: true, range: false });
  });

  it.each(['mousedown', 'click', 'contextmenu', 'dragstart', 'keydown', 'change'])(
    'blocks %s before it reaches a widget',
    (type) => {
      const input = document.createElement('input');
      document.body.append(input);
      const widgetHandler = vi.fn();
      input.addEventListener(type, widgetHandler);
      cleanup = installPreviewInteractionGuard(document, vi.fn());

      const event = new Event(type, { bubbles: true, cancelable: true });
      input.dispatchEvent(event);

      expect(widgetHandler).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('reports a right-click target and position while still blocking the native menu', () => {
    const widget = document.createElement('div');
    document.body.append(widget);
    const widgetHandler = vi.fn();
    widget.addEventListener('contextmenu', widgetHandler);

    const onContextMenu = vi.fn();
    cleanup = installPreviewInteractionGuard(document, vi.fn(), onContextMenu);

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 42,
      clientY: 84,
    });
    widget.dispatchEvent(event);

    expect(onContextMenu).toHaveBeenCalledWith(widget, 42, 84);
    expect(widgetHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('blurs a field that was focused before config mode is enabled', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    cleanup = installPreviewInteractionGuard(document, vi.fn());

    expect(document.activeElement).toBe(document.body);
  });

  it('allows scrolling and restores interaction after cleanup', () => {
    const widget = document.createElement('button');
    document.body.append(widget);
    const widgetHandler = vi.fn();
    widget.addEventListener('click', widgetHandler);
    cleanup = installPreviewInteractionGuard(document, vi.fn());

    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    widget.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);

    cleanup();
    cleanup = undefined;
    widget.click();
    expect(widgetHandler).toHaveBeenCalledOnce();
  });
});
