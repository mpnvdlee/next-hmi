/**
 * Deterministic coverage for the virtualized-list scroll-to-selection retry
 * in index.tsx (see the comment above the effect there): on open, a deep
 * binding must be scrolled into view, but the virtualizer's measured size can
 * still be zero on the first frame, so the effect retries across animation
 * frames (bounded at 10 attempts) until the target row is actually rendered.
 *
 * `@tanstack/react-virtual` and `requestAnimationFrame` are both replaced with
 * synchronous, fully controlled fakes so the retry/cap logic is exercised
 * without depending on real browser layout — real geometry is item 37's job.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import VariableBindingPicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

let landsOnFirstAttempt = false;
let lastScrolledIndex = -1;
const scrollToIndex = vi.fn((idx: number) => {
  lastScrolledIndex = idx;
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    // Not-yet-landed: always empty (mirrors a zero-height scroll container on
    // the first frames). Lands-on-first-attempt: once the component has
    // actually asked to scroll to a row, reports that row as rendered —
    // simulating the retry succeeding on its first pass. Never reports
    // anything before the first `scrollToIndex` call, so unrelated renders
    // that happen before the retry effect runs don't spuriously "land".
    getVirtualItems: () =>
      landsOnFirstAttempt && lastScrolledIndex !== -1 ? [{ index: lastScrolledIndex }] : [],
    scrollToIndex,
  }),
}));

const mockedApiJson = vi.mocked(apiJson);

function stubSyncRaf() {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

beforeEach(() => {
  landsOnFirstAttempt = false;
  lastScrolledIndex = -1;
  scrollToIndex.mockClear();
  mockedApiJson.mockReset();
  useConfigStore.setState({
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'Page 1',
        sections: {
          content: [
            {
              id: 'w1',
              type: 'NumericDisplay',
              name: 'Display',
              properties: { value: { $var: { path: 'PLC:Speed' } } },
            },
          ],
        },
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useEditorDomainStore.getState().closeBindingPicker();
});

describe('VariableBindingPicker — scroll-to-selection retry', () => {
  it('stops retrying as soon as the target row lands in the virtualizer window', async () => {
    stubSyncRaf();
    landsOnFirstAttempt = true;
    mockedApiJson
      .mockResolvedValueOnce([{ name: 'PLC', type: 'static' }] as never)
      .mockResolvedValueOnce({
        variables: [{ display_name: 'Speed', data_type: 'Float', enabled: true, writable: true }],
      } as never);

    useEditorDomainStore.getState().openBindingPicker('w1', 'value', {
      onPick: () => {},
      filter: { type: 'Float' },
    });
    render(<VariableBindingPicker />);

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    // Give any stray re-run of the effect a chance to fire before asserting the count is stable.
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(2));

    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('caps retries at 10 attempts when the row never lands', async () => {
    stubSyncRaf();
    landsOnFirstAttempt = false;
    mockedApiJson
      .mockResolvedValueOnce([{ name: 'PLC', type: 'static' }] as never)
      .mockResolvedValueOnce({
        variables: [{ display_name: 'Speed', data_type: 'Float', enabled: true, writable: true }],
      } as never);

    useEditorDomainStore.getState().openBindingPicker('w1', 'value', {
      onPick: () => {},
      filter: { type: 'Float' },
    });
    render(<VariableBindingPicker />);

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(10));

    // No further attempts are scheduled once the cap is hit.
    expect(scrollToIndex).toHaveBeenCalledTimes(10);
  });

  it('does not scroll at all when there is no current binding to reveal', async () => {
    stubSyncRaf();
    mockedApiJson.mockResolvedValueOnce([{ name: 'PLC', type: 'static' }] as never);

    // No $var bound on the target property — currentKey is null.
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page 1',
          sections: {
            content: [{ id: 'w1', type: 'NumericDisplay', name: 'Display', properties: {} }],
          },
        },
      ],
    });
    useEditorDomainStore.getState().openBindingPicker('w1', 'value', {
      onPick: () => {},
      filter: { type: 'Float' },
    });
    render(<VariableBindingPicker />);

    await waitFor(() => expect(mockedApiJson).toHaveBeenCalled());
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
