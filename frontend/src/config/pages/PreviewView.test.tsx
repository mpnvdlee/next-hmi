// Renders real stdlib widgets (Label); bind the SDK and resolve their modules.
import '../../../widgets/testSdk';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { useComponentStore } from '@shared/store/componentStore';
import { registerComponents } from '@hmi/registry/widgetRegistry';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { PageNode } from '@shared/types/config';
import PreviewView from './PreviewView';

const ORIGIN = window.location.origin;

// jsdom lacks these browser APIs that ShellRegion / scroll-into-view rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = vi.fn();

vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ languages: [{ code: 'en' }], rows: {}, revision: 'r1' }),
  }),
);

const BUTTON_PAGE: PageNode = {
  id: 'page1',
  type: 'page',
  title: 'Home',
  sections: {
    content: [
      {
        id: 'comp-1',
        type: 'Button',
        name: 'Btn',
        properties: { label: { $static: 'Click' } },
        layout: {},
      },
    ],
  },
};

const TWO_BUTTON_PAGE: PageNode = {
  id: 'page1',
  type: 'page',
  title: 'Home',
  sections: {
    content: [
      { id: 'comp-1', type: 'Button', name: 'One', properties: {}, layout: {} },
      { id: 'comp-2', type: 'Button', name: 'Two', properties: {}, layout: {} },
    ],
  },
};

const GROUP_PAGES: PageNode[] = [
  {
    id: 'grp1',
    type: 'page-group',
    title: 'Group',
    children: [{ id: 'page1', type: 'page', title: 'Home', sections: { content: [] } }],
  },
];

function setupStores(pages: PageNode[]) {
  useConfigStore.setState({
    pages,
    header: [],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    shell: {},
    loadedPageIds: new Set(['page1']),
  });
  useVariableStore.setState({
    values: {},
    varMeta: {},
    snapshotReceived: true,
    contextReadyPageIds: ['page1'],
    wsConnected: false,
    opcuaConnected: {},
  });
}

function renderPreview(pageId = 'page1') {
  return render(
    <MemoryRouter initialEntries={[`/preview/${pageId}`]}>
      <Routes>
        <Route path="/preview/:pageId" element={<PreviewView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function dispatchFromParent(data: unknown, origin = ORIGIN, source: unknown = window): void {
  const event = new MessageEvent('message', { data, origin, source: source as Window | null });
  window.dispatchEvent(event);
}

describe('PreviewView — outbound protocol', () => {
  beforeEach(() => setupStores([BUTTON_PAGE]));

  it('announces preview_ready to the parent on mount', () => {
    const postMessage = vi.spyOn(window, 'postMessage');
    renderPreview();
    expect(postMessage).toHaveBeenCalledWith({ type: 'preview_ready' }, ORIGIN);
  });

  it('reports its own route to the parent as preview_location', () => {
    const postMessage = vi.spyOn(window, 'postMessage');
    renderPreview();
    expect(postMessage).toHaveBeenCalledWith({ type: 'preview_location', pageId: 'page1' }, ORIGIN);
  });

  it('reports component_clicked with pathIds when a rendered widget is pressed', () => {
    // Config mode disables plain 'click' entirely (previewInteractionGuard
    // swallows it) and reports selection from 'pointerdown' instead — see
    // previewInteractionGuard.ts.
    const postMessage = vi.spyOn(window, 'postMessage');
    const { container } = renderPreview();
    const wrapper = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(wrapper).toBeInTheDocument();

    fireEvent.pointerDown(wrapper);

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'component_clicked', id: 'comp-1', pathIds: ['comp-1'], toggle: false },
      ORIGIN,
    );
  });

  it('reports the instance, not the widget its definition drew', async () => {
    // The definition's nodes are not in the tree being edited, and their ids
    // are minted in a namespace of their own — so a click on one has to arrive
    // as the instance rather than as some same-named widget elsewhere.
    useComponentStore.setState({
      components: [
        {
          id: 'card',
          name: 'Card',
          componentProperties: {},
          children: [{ id: 'comp-1', type: 'Label', name: 'Title', properties: {} }],
        } as unknown as ComponentDefinition,
      ],
      draftComponents: {},
    });
    registerComponents(useComponentStore.getState().components);
    setupStores([
      {
        id: 'page1',
        type: 'page',
        title: 'Home',
        sections: {
          content: [
            { id: 'card-1', type: '$component:card', name: 'Card', properties: {}, layout: {} },
          ],
        },
      },
    ]);
    const postMessage = vi.spyOn(window, 'postMessage');
    const { container } = renderPreview();

    // ComponentRenderer is lazy — the instance's insides arrive a tick later.
    await waitFor(() =>
      expect(container.querySelector('[data-widget-id="comp-1"]')).toBeInTheDocument(),
    );
    const inner = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(inner).toHaveAttribute('data-widget-source', 'definition');

    fireEvent.pointerDown(inner);

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'component_clicked', id: 'card-1', pathIds: ['card-1'], toggle: false },
      ORIGIN,
    );
  });
});

describe('PreviewView — inbound protocol / origin checks', () => {
  beforeEach(() => setupStores([BUTTON_PAGE]));

  it('applies the selection highlight to the matching widget wrapper', () => {
    const { container } = renderPreview();
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: 'comp-1' });
    });
    const wrapper = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(wrapper).toHaveClass('hmi-preview-node--selected');
  });

  it('highlights every id of a multi-selection', () => {
    setupStores([TWO_BUTTON_PAGE]);
    const { container } = renderPreview();

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });

    expect(container.querySelectorAll('.hmi-preview-node--selected')).toHaveLength(2);
  });

  it('unpaints only the id that left the selection', () => {
    setupStores([TWO_BUTTON_PAGE]);
    const { container } = renderPreview();

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: null });
    });

    expect(container.querySelector('[data-widget-id="comp-1"]')).toHaveClass(
      'hmi-preview-node--selected',
    );
    expect(container.querySelector('[data-widget-id="comp-2"]')).not.toHaveClass(
      'hmi-preview-node--selected',
    );
  });

  it('scrolls to the lead only, and only once per lead', () => {
    setupStores([TWO_BUTTON_PAGE]);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = renderPreview();
    const lead = container.querySelector('[data-widget-id="comp-2"]');

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(lead?.contains(scrollIntoView.mock.instances[0] as Node)).toBe(true);
  });

  it('scrolls again when a lead is removed and re-added', () => {
    setupStores([TWO_BUTTON_PAGE]);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPreview();

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: null });
    });
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1', 'comp-2'], lead: 'comp-2' });
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('does not scroll when the message reports a removal', () => {
    setupStores([TWO_BUTTON_PAGE]);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPreview();

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: null });
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('treats a repeat set_selected carrying the same ids as a no-op', () => {
    // Every canvas click echoes the selection back, unchanged ones included. A fresh
    // array there would rebuild the selection set and re-run each window item's memo.
    setupStores([TWO_BUTTON_PAGE]);
    renderPreview();
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: 'comp-1' });
    });

    const querySelectorAll = vi.spyOn(Element.prototype, 'querySelectorAll');
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: 'comp-1' });
    });
    // Unchanged state means no re-render, so the highlight effect never runs again.
    const rerendered = querySelectorAll.mock.calls.length > 0;
    querySelectorAll.mockRestore();
    expect(rerendered).toBe(false);
  });

  it('clears the highlight when selection is set back to null', () => {
    const { container } = renderPreview();
    act(() => dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: 'comp-1' }));
    act(() => dispatchFromParent({ type: 'set_selected', ids: [], lead: null }));

    const wrapper = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(wrapper).not.toHaveClass('hmi-preview-node--selected');
  });

  it('ignores an inbound message from the wrong origin', () => {
    const { container } = renderPreview();
    act(() => {
      dispatchFromParent({ type: 'set_selected', id: 'comp-1' }, 'https://evil.example');
    });
    const wrapper = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(wrapper).not.toHaveClass('hmi-preview-node--selected');
  });

  it('ignores an inbound message whose source is not window.parent', () => {
    const { container } = renderPreview();
    act(() => {
      dispatchFromParent({ type: 'set_selected', id: 'comp-1' }, ORIGIN, null);
    });
    const wrapper = container.querySelector('[data-widget-id="comp-1"]') as HTMLElement;
    expect(wrapper).not.toHaveClass('hmi-preview-node--selected');
  });

  it('toggles config-mode styling via set_mode', () => {
    const { container } = renderPreview();
    const root = container.querySelector('.hmi-root') as HTMLElement;
    expect(root).toHaveClass('hmi-root--config-mode'); // default mode is 'config'

    act(() => dispatchFromParent({ type: 'set_mode', mode: 'test' }));
    expect(root).not.toHaveClass('hmi-root--config-mode');

    act(() => dispatchFromParent({ type: 'set_mode', mode: 'config' }));
    expect(root).toHaveClass('hmi-root--config-mode');
  });

  it('paints scrollbars only while shell.showScrollbars is on', () => {
    const { container } = renderPreview();
    const root = container.querySelector('.hmi-root') as HTMLElement;
    expect(root).not.toHaveClass('hmi-root--scrollbars');

    act(() => useConfigStore.setState({ shell: { showScrollbars: true } }));
    expect(container.querySelector('.hmi-root')).toHaveClass('hmi-root--scrollbars');

    act(() => useConfigStore.setState({ shell: {} }));
    expect(container.querySelector('.hmi-root')).not.toHaveClass('hmi-root--scrollbars');
  });

  it('replaces the store from an inbound pages_update carrying real section content', () => {
    // LivePreview's `pages` field is the parent's own already-hydrated config
    // store, so for a loaded page its `sections.content` is already real —
    // that is the actual path new content reaches the preview through.
    renderPreview();
    act(() => {
      dispatchFromParent({
        type: 'pages_update',
        pages: [
          {
            id: 'page1',
            type: 'page',
            title: 'Home',
            sections: {
              content: [
                {
                  id: 'comp-2',
                  type: 'Button',
                  name: 'Btn2',
                  properties: { label: { $static: 'New' } },
                  layout: {},
                },
              ],
            },
          },
        ],
        header: [],
        footer: [],
        leftSidebar: [],
        rightSidebar: [],
        shell: {},
        dialogs: [],
        globalEvents: {},
        pageContent: {},
      });
    });

    expect(useConfigStore.getState().pages[0]).toMatchObject({
      id: 'page1',
      sections: { content: [{ id: 'comp-2', type: 'Button' }] },
    });
  });

  it('does not fabricate section content from pageContent alone — a page must arrive with real sections', () => {
    // normalizePageNode() (via store.setPages) reads only `sections`; the
    // `children` key the pages_update handler merges from `pageContent` onto
    // the incoming page object is not a recognised PageConfig field, so it is
    // silently dropped by normalization. In practice this is harmless because
    // the parent always sends real `sections.content` for loaded pages (see
    // the test above) — but the pageContent-driven merge itself is inert.
    renderPreview();
    act(() => {
      dispatchFromParent({
        type: 'pages_update',
        pages: [{ id: 'page1', type: 'page', title: 'Home', sections: {} }],
        header: [],
        footer: [],
        leftSidebar: [],
        rightSidebar: [],
        shell: {},
        dialogs: [],
        globalEvents: {},
        pageContent: {
          page1: [
            {
              id: 'comp-2',
              type: 'Button',
              name: 'Btn2',
              properties: { label: { $static: 'New' } },
              layout: {},
            },
          ],
        },
      });
    });

    expect(useConfigStore.getState().pages[0]).toMatchObject({
      id: 'page1',
      sections: { content: [] },
    });
  });

  it('stops listening for messages after unmount', () => {
    const { container, unmount } = renderPreview();
    unmount();

    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['comp-1'], lead: 'comp-1' });
    });
    // The component is unmounted; the wrapper reference from before unmount
    // must not have gained the class (no listener left to apply it).
    const wrapper = container.querySelector('[data-widget-id="comp-1"]');
    expect(wrapper).toBeNull();
  });
});

describe('PreviewView — page-group selection highlighting', () => {
  beforeEach(() => setupStores(GROUP_PAGES));

  it('descends past the chromeless display:contents group wrapper to highlight a real descendant', () => {
    renderPreview();
    act(() => {
      dispatchFromParent({ type: 'set_selected', ids: ['grp1'], lead: 'grp1' });
    });

    const mark = document.querySelector('[data-page-group-id="grp1"]') as HTMLElement;
    expect(mark).toBeInTheDocument();
    // The chromeless wrapper itself never gets the class...
    expect(mark).not.toHaveClass('hmi-page-group--selected');
    // ...but some box-producing descendant inside it does.
    expect(mark.querySelector('.hmi-page-group--selected')).not.toBeNull();
  });

  it('clears the page-group highlight on deselection', () => {
    renderPreview();
    act(() => dispatchFromParent({ type: 'set_selected', ids: ['grp1'], lead: 'grp1' }));
    act(() => dispatchFromParent({ type: 'set_selected', ids: [], lead: null }));

    expect(document.querySelector('.hmi-page-group--selected')).toBeNull();
  });
});
