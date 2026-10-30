import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useAdsPlcBrowse } from './useAdsPlcBrowse';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

const ROOT = {
  node_id: '',
  display_name: 'PLC',
  data_type: null,
  browse_mode: 'lazy',
  children: Array.from({ length: 10 }, (_, i) => ({
    node_id: `F${i}`,
    display_name: `F${i}`,
    data_type: null,
    children: [],
    has_children: true,
  })),
};

function render(active = true) {
  return renderHook(({ on }) => useAdsPlcBrowse('plc', on), { initialProps: { on: active } });
}

describe('useAdsPlcBrowse', () => {
  beforeEach(() => {
    mockedApiJson.mockReset();
  });

  it('clears a failed browse once a later one succeeds', async () => {
    mockedApiJson.mockRejectedValueOnce(new Error('not connected')).mockResolvedValue(ROOT);
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.error).toBe('not connected'));

    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(result.current.nodes).not.toBeNull());
    expect(result.current.error).toBeNull();
  });

  it('fetches at most four lazy levels at once, the rest as those finish', async () => {
    const pending: (() => void)[] = [];
    mockedApiJson.mockImplementation((url: string) =>
      url.includes('node_id=')
        ? new Promise((resolve) => pending.push(() => resolve({ children: [] })))
        : Promise.resolve(ROOT),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.nodes).not.toBeNull());

    act(() => result.current.ensureLoaded(ROOT.children.map((c) => c.node_id)));
    expect(mockedApiJson).toHaveBeenCalledTimes(1 + 4);

    await act(async () => pending.shift()!());
    expect(mockedApiJson).toHaveBeenCalledTimes(1 + 5);
  });

  it('retries a level that failed when it is asked for again', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      url.includes('node_id=') ? Promise.reject(new Error('timeout')) : Promise.resolve(ROOT),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.nodes).not.toBeNull());

    act(() => result.current.ensureLoaded(['F0']));
    await waitFor(() => expect(result.current.error).toBe('timeout'));
    act(() => result.current.ensureLoaded(['F0']));
    expect(mockedApiJson).toHaveBeenCalledTimes(3);
  });
});
