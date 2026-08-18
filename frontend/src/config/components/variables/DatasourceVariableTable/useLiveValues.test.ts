import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVariableStore } from '@hmi/store/variableStore';
import type { RowItem } from '@config/components/ui/datasourceTreeHelpers';
import { useLiveValues } from './useLiveValues';
import type { VirtualizerIndexLike } from './virtualizerTypes';

const { sendWsMessage } = vi.hoisted(() => ({ sendWsMessage: vi.fn() }));
vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage }));

function makeRow(path: string): RowItem {
  return {
    kind: 'variable',
    entry: { kind: 'variable', display_name: path, data_type: 'Float', enabled: true },
    depth: 0,
    path,
  };
}

describe('useLiveValues', () => {
  let rafSpy: ReturnType<typeof vi.fn>;
  let originalRaf: typeof requestAnimationFrame;

  async function flushRaf() {
    await act(async () => {
      await new Promise((resolve) => originalRaf(resolve));
    });
  }

  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {}, snapshotReceived: true });
    sendWsMessage.mockClear();

    originalRaf = globalThis.requestAnimationFrame.bind(globalThis);
    rafSpy = vi.fn((cb: FrameRequestCallback) => originalRaf(cb));
    vi.stubGlobal('requestAnimationFrame', rafSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup() {
    // Rows 'a' and 'b' are within the virtualizer's visible window; 'c' is
    // scrolled out of view.
    const rows: RowItem[] = [makeRow('a'), makeRow('b'), makeRow('c')];
    const getVirtualItems = vi.fn(() => [{ index: 0 }, { index: 1 }]);
    const virtualizer: VirtualizerIndexLike = { getVirtualItems };
    const scrollRef = { current: null };

    const rendered = renderHook(() =>
      useLiveValues({ showLive: true, dsName: 'PLC', rows, virtualizer, scrollRef }),
    );

    rafSpy.mockClear();
    return rendered;
  }

  it('does not trigger a read for a key belonging to a different datasource (§7.4)', async () => {
    setup();

    act(() => {
      useVariableStore.getState().setScalar('OTHER:x', 1);
    });
    await flushRaf();

    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('does not trigger a read for a key that is in the table but scrolled out of view (§7.4)', async () => {
    setup();

    act(() => {
      useVariableStore.getState().setScalar('PLC:c', 1);
    });
    await flushRaf();

    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('does not trigger a read for an unrelated WebSocket disconnect flag (§7.4)', async () => {
    setup();

    act(() => {
      useVariableStore.getState().setWsConnected(false);
    });
    await flushRaf();

    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('triggers a read and updates the value for a key in the visible rows (§7.4)', async () => {
    const { result } = setup();

    act(() => {
      useVariableStore.getState().setScalar('PLC:a', 42);
    });
    await flushRaf();

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(result.current['PLC:a']).toBe('42');
  });
});
