import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { PageConfig } from '@shared/types/config';
import { ModalStack } from './ModalStack';

// The overlay's own page must reveal at once, so the settle window is the only
// thing under test here; and the probe stands in for a real built-in, whose
// lazy module jsdom cannot fetch.
vi.mock('@hmi/registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hmi/registry/widgetRegistry')>();
  const { LabeledProbe } = await import('./__fixtures__/probeWidgets');
  return {
    ...actual,
    widgetModulesLoaded: () => true,
    prefetchWidgetModules: () => Promise.resolve(),
    widgetRegistry: {
      ...actual.widgetRegistry,
      LabeledProbe,
    },
  };
});

const OVERLAY_PAGE: PageConfig = {
  id: 'ov1',
  title: 'Overlay',
  type: 'page',
  sections: {
    content: [
      {
        id: 'w1',
        type: 'LabeledProbe',
        name: 'Probe',
        properties: { label: 'Start', variable: { $var: { path: 'PLC:Speed' } } },
      },
    ],
  },
};

function renderOverlay() {
  return render(
    <MemoryRouter>
      <ModalStack />
    </MemoryRouter>,
  );
}

describe('ModalStack page overlays — the settle window', () => {
  beforeEach(() => {
    useConfigStore.setState({
      dialogs: [],
      pages: [OVERLAY_PAGE],
      loadedPageIds: new Set(['ov1']),
    });
    useHmiStore.setState({
      openPageOverlays: [
        { pageId: 'ov1', componentProperties: {}, size: 'auto', placement: 'center' },
      ],
    });
    // A variable that exists but has never delivered a value — the state the
    // overlay is in for as long as its own set_context read takes.
    useVariableStore.setState({
      values: {},
      varMeta: { 'PLC:Speed': { type: { kind: 'scalar', base: 'Float', array: false } } },
      metadataReceived: true,
      snapshotReceived: true,
      wsConnected: true,
      opcuaConnected: {},
      contextReadyPageIds: ['host'],
    });
  });

  it('holds the mark off an overlay whose own variables are still in flight', () => {
    // The host page settled long ago; inheriting its gate would mark every
    // widget in the overlay the instant it opened.
    const { container } = renderOverlay();
    expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
  });

  it('marks it once the backend acks the overlay page itself', () => {
    useVariableStore.setState({ contextReadyPageIds: ['host', 'ov1'] });
    const { container } = renderOverlay();
    expect(container.querySelector('.hmi-binding-overlay')).toHaveClass(
      'hmi-binding-overlay--nodata',
    );
  });

  it('settles a page-group overlay on the page inside it, not the group id', () => {
    // A page group has no page file and is not what `set_context` sends, so the
    // backend never acks it. Keying the gate on the group id would leave the
    // overlay waiting out the whole grace on every open.
    useConfigStore.setState({
      pages: [
        {
          id: 'grp',
          title: 'Group',
          type: 'page-group',
          children: [OVERLAY_PAGE],
        } as unknown as PageConfig,
      ],
    });
    useHmiStore.setState({
      openPageOverlays: [
        { pageId: 'grp', componentProperties: {}, size: 'auto', placement: 'center' },
      ],
    });
    useVariableStore.setState({ contextReadyPageIds: ['host', 'ov1'] });
    const { container } = renderOverlay();
    expect(container.querySelector('.hmi-binding-overlay')).toHaveClass(
      'hmi-binding-overlay--nodata',
    );
  });
});
