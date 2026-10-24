import { act, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import { ActionNavigation } from './ActionNavigation';

const PAGES = [
  { id: 'home', type: 'page' as const, title: 'Home' },
  { id: 'station', type: 'page' as const, title: 'Station' },
];

let path = '';
function Location() {
  path = useLocation().pathname;
  return null;
}

function renderRuntime() {
  render(
    <MemoryRouter initialEntries={['/pages/home']}>
      <ActionNavigation />
      <Location />
    </MemoryRouter>,
  );
}

const overlay = { componentProperties: {}, size: 'medium' as const, placement: 'center' as const };

describe('navigateToPage', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never, dialogs: [] });
    useHmiStore.setState({
      openPageOverlays: [
        { ...overlay, pageId: 'station-popup' },
        { ...overlay, pageId: 'confirm' },
      ],
      pendingNavigation: null,
    });
  });

  it('closes every overlay, then routes to the page an input names', () => {
    renderRuntime();
    act(() =>
      executeWidgetActions([{ type: 'navigateToPage', pageId: { $componentProp: 'target' } }], {
        evalCtx: { inputScopeProps: { target: 'station' } },
      }),
    );
    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
    expect(path).toBe('/pages/station');
    expect(useHmiStore.getState().pendingNavigation).toBeNull();
  });

  it('does nothing for an input naming no navigable page', () => {
    renderRuntime();
    for (const target of ['', 'station-popup']) {
      act(() =>
        executeWidgetActions([{ type: 'navigateToPage', pageId: { $componentProp: 'target' } }], {
          evalCtx: { inputScopeProps: { target } },
        }),
      );
    }
    expect(useHmiStore.getState().openPageOverlays).toHaveLength(2);
    expect(path).toBe('/pages/home');
  });
});
