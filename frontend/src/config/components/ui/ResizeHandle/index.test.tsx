import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResizeHandle from './index';

// Drags are throttled to one update per frame; collect the frame callbacks and
// flush them by hand so the assertions don't have to wait on a real frame.
let frames: FrameRequestCallback[] = [];

function flushFrames() {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(0);
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.classList.remove('cfg-resizing');
});

function down(handle: Element, clientX: number) {
  fireEvent.pointerDown(handle, { clientX, button: 0, pointerId: 1, isPrimary: true });
}

function move(clientX: number) {
  fireEvent.pointerMove(window, { clientX, pointerId: 1 });
  flushFrames();
}

function up() {
  fireEvent.pointerUp(window, { pointerId: 1 });
}

function drag(handle: Element, fromX: number, toXs: number[]) {
  down(handle, fromX);
  for (const x of toXs) move(x);
}

describe('ResizeHandle', () => {
  it('widens a right-side panel when dragging left', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} side="right" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [280]);

    // side="right": dragging left (clientX decreases) widens the panel.
    expect(onResize).toHaveBeenLastCalledWith(320);
  });

  it('widens a left-side panel when dragging right', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} side="left" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [330]);

    expect(onResize).toHaveBeenLastCalledWith(330);
  });

  it('clamps the new width at the minimum', () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizeHandle width={220} onResize={onResize} side="right" min={200} max={600} />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    // Dragging right on a right-side handle shrinks the panel — push far past the floor.
    drag(handle, 300, [800]);

    expect(onResize).toHaveBeenLastCalledWith(200);
  });

  it('clamps the new width at the maximum', () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizeHandle width={220} onResize={onResize} side="right" min={200} max={600} />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [-1000]);

    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it('uses the default 200–600 bounds when none are given', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [-10_000]);

    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it('never squeezes the center column below minCenter', () => {
    const onResize = vi.fn();
    const { container } = render(
      <div>
        <div data-testid="center" />
        <ResizeHandle width={300} onResize={onResize} side="right" minCenter={320} max={1000} />
      </div>,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;
    const center = handle.previousElementSibling as HTMLElement;
    // jsdom reports zero-size boxes, so stand in for a 400px-wide center column.
    vi.spyOn(center, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);

    drag(handle, 300, [-10_000]);

    // 300 start + (400 center − 320 floor) of headroom.
    expect(onResize).toHaveBeenLastCalledWith(380);
  });

  it('tracks the drag across multiple pointermove events from the same starting width', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} side="right" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [290, 250, 310]);

    expect(onResize).toHaveBeenNthCalledWith(1, 310);
    expect(onResize).toHaveBeenNthCalledWith(2, 350);
    expect(onResize).toHaveBeenNthCalledWith(3, 290);
  });

  it('reports the final width once when the drag ends', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const { container } = render(
      <ResizeHandle width={300} onResize={onResize} onResizeEnd={onResizeEnd} side="right" />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    drag(handle, 300, [280]);
    expect(onResizeEnd).not.toHaveBeenCalled();

    up();
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenCalledWith(320);
  });

  it('marks the body while dragging and clears it on pointerup', () => {
    const { container } = render(<ResizeHandle width={300} onResize={vi.fn()} side="right" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    down(handle, 300);
    expect(document.body.classList.contains('cfg-resizing')).toBe(true);

    up();
    expect(document.body.classList.contains('cfg-resizing')).toBe(false);
  });

  it('stops resizing once the drag ends', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} side="right" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    down(handle, 300);
    up();
    onResize.mockClear();
    move(100);

    expect(onResize).not.toHaveBeenCalled();
  });

  it('ends the drag when the pointer is cancelled', () => {
    const onResizeEnd = vi.fn();
    const { container } = render(
      <ResizeHandle width={300} onResize={vi.fn()} onResizeEnd={onResizeEnd} side="right" />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    down(handle, 300);
    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(document.body.classList.contains('cfg-resizing')).toBe(false);
    expect(onResizeEnd).toHaveBeenCalledWith(300);
  });

  it('cleans up when unmounted mid-drag', () => {
    const onResize = vi.fn();
    const { container, unmount } = render(
      <ResizeHandle width={300} onResize={onResize} side="right" />,
    );
    down(container.querySelector('.cfg-resize-handle')!, 300);

    unmount();
    onResize.mockClear();
    move(100);

    expect(document.body.classList.contains('cfg-resizing')).toBe(false);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('ignores non-primary buttons', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle width={300} onResize={onResize} side="right" />);
    const handle = container.querySelector('.cfg-resize-handle')!;

    fireEvent.pointerDown(handle, { clientX: 300, button: 2, pointerId: 1 });
    move(200);

    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.classList.contains('cfg-resizing')).toBe(false);
  });

  it('resizes with the arrow keys and commits each step', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const { container } = render(
      <ResizeHandle width={300} onResize={onResize} onResizeEnd={onResizeEnd} side="right" />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(316);
    expect(onResizeEnd).toHaveBeenLastCalledWith(316);

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(298);
  });

  it('restores the default width on double-click', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const { container } = render(
      <ResizeHandle width={520} onResize={onResize} onResizeEnd={onResizeEnd} defaultWidth={340} />,
    );

    fireEvent.doubleClick(container.querySelector('.cfg-resize-handle')!);

    expect(onResize).toHaveBeenCalledWith(340);
    expect(onResizeEnd).toHaveBeenCalledWith(340);
  });

  it('exposes itself as a separator for assistive tech', () => {
    const { container } = render(
      <ResizeHandle width={300} onResize={vi.fn()} min={200} max={600} label="Resize left panel" />,
    );
    const handle = container.querySelector('.cfg-resize-handle')!;

    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('aria-label', 'Resize left panel');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', '200');
    expect(handle).toHaveAttribute('aria-valuemax', '600');
  });
});
