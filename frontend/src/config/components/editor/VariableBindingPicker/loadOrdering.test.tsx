/**
 * The picker overlay is mounted for the whole ConfigShell lifetime, so its
 * datasource cache survives every close — a datasource left marked "loaded" but
 * empty stays broken until a page reload. These tests pin the invariants that
 * make that impossible: variables are fetched because a datasource is *rendered
 * expanded*, never as a side effect of whichever request happened to land
 * first, and a failed fetch is retried on demand instead of on every render.
 *
 * Also covers "Clear binding": it empties the binding but keeps the property on
 * `$var`, rather than deleting the property (which would reset it to `$static`).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { findComponentInPages } from '@shared/utils/widgetTree';
import VariableBindingPicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

// jsdom gives the scroll container zero height, so the real virtualizer renders
// no rows at all. Render every row at the picker's 26px estimate instead.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 26,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        size: 26,
        start: index * 26,
      })),
    scrollToIndex: () => {},
  }),
}));

const mockedApiJson = vi.mocked(apiJson);

const SPEED_VARIABLES = {
  variables: [{ display_name: 'Speed', data_type: 'Float', enabled: true, writable: true }],
};

/** Rows are 26px each: one datasource header + one variable = 52px. */
const listHeight = () => document.querySelector('.editor-binding-list > div');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function variableRequests(datasource?: string) {
  return mockedApiJson.mock.calls.filter(([url]) =>
    datasource
      ? String(url).startsWith(`/api/datasources/${datasource}/variables`)
      : String(url).includes('/variables'),
  );
}

function boundWidgetPage(value: unknown) {
  return [
    {
      id: 'page-1',
      type: 'page' as const,
      title: 'Page 1',
      sections: {
        content: [{ id: 'w1', type: 'NumericDisplay', name: 'Display', properties: { value } }],
      },
    },
  ];
}

function widgetValue() {
  return findComponentInPages(useConfigStore.getState().pages, 'w1')?.properties?.value;
}

beforeEach(() => {
  mockedApiJson.mockReset();
  useConfigStore.setState({ pages: boundWidgetPage({ $var: { path: 'PLC:Speed' } }) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useEditorDomainStore.getState().closeBindingPicker();
});

function openOnBoundWidget(options: Record<string, unknown> = {}) {
  useEditorDomainStore.getState().openBindingPicker('w1', 'value', {
    filter: { type: 'Float' },
    ...options,
  });
}

describe('VariableBindingPicker — datasource loading order', () => {
  it('waits for the datasource list before fetching any variable tree', async () => {
    const headers = deferred<unknown>();
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources' ? headers.promise : (Promise.resolve(SPEED_VARIABLES) as never),
    );

    openOnBoundWidget();
    render(<VariableBindingPicker />);

    await waitFor(() => expect(mockedApiJson).toHaveBeenCalled());
    // The current binding names a datasource, but nothing may be fetched for it
    // until that datasource exists in the tree — otherwise its children land in
    // an empty tree and are dropped.
    expect(variableRequests()).toHaveLength(0);

    await act(async () => {
      headers.resolve([{ name: 'PLC', type: 'static' }]);
    });

    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(1));
    // Datasource header + the bound variable: expanded, with its children kept.
    await waitFor(() => expect(listHeight()).toHaveStyle({ height: '52px' }));
  });

  it('loads a datasource added between two opens on the first click', async () => {
    let datasources = [{ name: 'PLC', type: 'static' }];
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? (Promise.resolve(datasources) as never)
        : (Promise.resolve(SPEED_VARIABLES) as never),
    );

    openOnBoundWidget();
    render(<VariableBindingPicker />);
    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(1));

    datasources = [
      { name: 'PLC', type: 'static' },
      { name: 'PLC2', type: 'static' },
    ];
    act(() => {
      useEditorDomainStore.getState().closeBindingPicker();
    });
    act(() => openOnBoundWidget());

    await waitFor(() => expect(screen.getByText('PLC2')).toBeInTheDocument());
    // Seeded collapsed even though it was unknown when the picker first opened.
    expect(variableRequests('PLC2')).toHaveLength(0);

    fireEvent.click(screen.getByText('PLC2').closest('.editor-binding-item--ds')!);
    await waitFor(() => expect(variableRequests('PLC2')).toHaveLength(1));
  });

  it('re-fetches a datasource whose load was aborted by closing the picker', async () => {
    let variables = deferred<unknown>();
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? (Promise.resolve([{ name: 'PLC', type: 'static' }]) as never)
        : (variables.promise as never),
    );

    openOnBoundWidget();
    render(<VariableBindingPicker />);
    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(1));

    act(() => {
      useEditorDomainStore.getState().closeBindingPicker();
    });
    // Lands after the close aborted it — must not be recorded as loaded.
    await act(async () => {
      variables.resolve(SPEED_VARIABLES);
    });

    variables = deferred<unknown>();
    act(() => openOnBoundWidget());

    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(2));
    await act(async () => {
      variables.resolve(SPEED_VARIABLES);
    });
    await waitFor(() => expect(listHeight()).toHaveStyle({ height: '52px' }));
  });

  it('does not retry a failed variable fetch until the datasource is expanded again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? (Promise.resolve([{ name: 'PLC', type: 'static' }]) as never)
        : (Promise.reject(new Error('boom')) as never),
    );

    openOnBoundWidget();
    render(<VariableBindingPicker />);

    await waitFor(() => expect(screen.getByText(/Could not load variables/)).toBeInTheDocument());
    const attempts = variableRequests('PLC').length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(variableRequests('PLC')).toHaveLength(attempts);

    // Collapsing and re-expanding is an explicit retry.
    const header = screen.getByText('PLC').closest('.editor-binding-item--ds')!;
    fireEvent.click(header);
    fireEvent.click(header);
    await waitFor(() => expect(variableRequests('PLC').length).toBeGreaterThan(attempts));
  });
});

describe('VariableBindingPicker — clear binding', () => {
  it('empties the binding but keeps the property on $var', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? (Promise.resolve([{ name: 'PLC', type: 'static' }]) as never)
        : (Promise.resolve(SPEED_VARIABLES) as never),
    );

    openOnBoundWidget();
    render(<VariableBindingPicker />);
    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Clear binding' }));

    expect(widgetValue()).toEqual({ $var: { path: '' } });
  });

  it('routes the cleared binding through onPick when the caller owns the write', async () => {
    const onPick = vi.fn();
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? (Promise.resolve([{ name: 'PLC', type: 'static' }]) as never)
        : (Promise.resolve(SPEED_VARIABLES) as never),
    );

    openOnBoundWidget({ onPick });
    render(<VariableBindingPicker />);
    await waitFor(() => expect(variableRequests('PLC')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Clear binding' }));

    expect(onPick).toHaveBeenCalledWith({ path: '' });
    // The caller's onPick is the only writer — the picker must not also patch.
    expect(widgetValue()).toEqual({ $var: { path: 'PLC:Speed' } });
  });
});
