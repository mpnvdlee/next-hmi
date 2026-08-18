import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentStore } from '@shared/store/componentStore';
import LivePreview from './index';

const ORIGIN = window.location.origin;

// jsdom has no ResizeObserver; TabBar's overflow-detection hook needs one to mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub;

function setupStores() {
  useConfigStore.setState({
    pages: [{ id: 'page1', type: 'page', title: 'Home', sections: { main: [] } }],
    loadedPageIds: new Set(['page1']),
    header: [],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    shell: {},
    globalEvents: {},
  });
  useEditorDomainStore.setState({
    selectedId: null,
    selectedIds: [],
    selectionAnchorId: null,
    selectedRegion: null,
    previewAreaId: 'page1',
  });
  useTranslationStore.setState({ languages: [{ code: 'en' }], translations: {} });
  useComponentStore.setState({ draftComponents: {}, components: [] });
}

/** postMessage delivery to a jsdom iframe's contentWindow is asynchronous
 *  (queued like a real browser), so a listener attached right after render()
 *  still reliably observes everything sent during mount effects. */
function renderPreview() {
  const utils = render(<LivePreview pageId="page1" />);
  const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement;
  const received: Record<string, unknown>[] = [];
  iframe.contentWindow?.addEventListener('message', (e) => {
    received.push(e.data as Record<string, unknown>);
  });
  return { ...utils, iframe, received };
}

function dispatchFromIframe(iframe: HTMLIFrameElement, data: unknown, origin = ORIGIN): void {
  const event = new MessageEvent('message', { data, origin, source: iframe.contentWindow });
  window.dispatchEvent(event);
}

async function waitForType(received: Record<string, unknown>[], type: string): Promise<void> {
  await waitFor(() => {
    expect(received.some((m) => m.type === type)).toBe(true);
  });
}

/** Drain the postMessage task queue plus the React work it schedules, so a message
 *  that a follow-up render would post has certainly arrived. */
async function flushMessages(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('LivePreview', () => {
  beforeEach(setupStores);

  it('points the iframe at /preview/:pageId', () => {
    const { iframe } = renderPreview();
    expect(iframe.getAttribute('src')).toBe('/preview/page1');
  });

  it('sends a pages_update with the full editor tree plus loaded page content on mount', async () => {
    const { received } = renderPreview();
    await waitForType(received, 'pages_update');

    const pagesUpdate = received.find((m) => m.type === 'pages_update');
    expect(pagesUpdate).toMatchObject({
      type: 'pages_update',
      header: [],
      footer: [],
      leftSidebar: [],
      rightSidebar: [],
      shell: {},
      dialogs: [],
      globalEvents: {},
      pageContent: { page1: [] },
    });
  });

  it('sends set_selected, navigate_preview, translations_update, components_update, and set_mode on mount', async () => {
    const { received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThanOrEqual(6));

    const types = received.map((m) => m.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'pages_update',
        'set_selected',
        'navigate_preview',
        'translations_update',
        'components_update',
        'set_mode',
      ]),
    );
  });

  it('re-syncs everything when the iframe (re)loads', async () => {
    const { iframe, received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    received.length = 0;

    fireEvent.load(iframe);

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    const types = received.map((m) => m.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'pages_update',
        'set_selected',
        'navigate_preview',
        'translations_update',
        'components_update',
        'set_mode',
      ]),
    );
  });

  it('re-sends the real lead on reload, so an unchanged selection still scrolls into view', async () => {
    // A freshly loaded preview knows nothing of what was already sent: diffing the
    // resync against the previous message would report no lead at all.
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    useEditorDomainStore.getState().setSelected('comp-1');
    const { iframe, received } = renderPreview();
    await waitFor(() =>
      expect(received.some((m) => m.type === 'set_selected' && m.lead === 'comp-1')).toBe(true),
    );
    received.length = 0;

    fireEvent.load(iframe);

    await waitForType(received, 'set_selected');
    expect(received.find((m) => m.type === 'set_selected')).toMatchObject({
      ids: ['comp-1'],
      lead: 'comp-1',
    });
  });

  it('re-syncs everything when the preview reports preview_ready', async () => {
    const { iframe, received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    received.length = 0;

    act(() => {
      dispatchFromIframe(iframe, { type: 'preview_ready' });
    });

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    const types = received.map((m) => m.type);
    expect(types).toContain('pages_update');
    expect(types).toContain('navigate_preview');
  });

  it('ignores an inbound message from the wrong origin', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    const { iframe } = renderPreview();

    act(() => {
      dispatchFromIframe(
        iframe,
        { type: 'component_clicked', id: 'comp-1' },
        'https://evil.example',
      );
    });

    expect(useEditorDomainStore.getState().selectedId).toBeNull();
  });

  it("ignores an inbound message whose source is not this iframe's contentWindow", () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    renderPreview();
    const event = new MessageEvent('message', {
      data: { type: 'component_clicked', id: 'comp-1' },
      origin: ORIGIN,
      source: window, // not the iframe's contentWindow
    });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(useEditorDomainStore.getState().selectedId).toBeNull();
  });

  it('accepts a same-origin, same-source component_clicked and echoes the selection back', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    const { iframe, received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    received.length = 0;

    act(() => {
      dispatchFromIframe(iframe, { type: 'component_clicked', id: 'comp-1', pathIds: ['comp-1'] });
    });

    await waitFor(() => {
      expect(useEditorDomainStore.getState().selectedId).toBe('comp-1');
    });
    await waitFor(() => {
      expect(
        received.some(
          (m) => m.type === 'set_selected' && Array.isArray(m.ids) && m.ids.includes('comp-1'),
        ),
      ).toBe(true);
    });
  });

  it('echoes a preview click exactly once, keeping the clicked id as the lead', async () => {
    // The store change the click causes re-runs the selection effect. If that effect
    // also posted, the preview would get a second message with lead:null and whether
    // it scrolls to the widget would depend on which one it rendered first.
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    const { iframe, received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    received.length = 0;

    act(() => {
      dispatchFromIframe(iframe, { type: 'component_clicked', id: 'comp-1', pathIds: ['comp-1'] });
    });
    await flushMessages();

    const selections = received.filter((m) => m.type === 'set_selected');
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ ids: ['comp-1'], lead: 'comp-1' });
  });

  it('scrolls to the clicked row when a shift-range is extended upward', async () => {
    // A range is always in document order, so the row the user shift-clicked above the
    // anchor is its first entry — neither the lead nor the last id to join the set.
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              { id: 'comp-1', type: 'Button', name: 'One', properties: {}, layout: {} },
              { id: 'comp-2', type: 'Button', name: 'Two', properties: {}, layout: {} },
              { id: 'comp-3', type: 'Button', name: 'Three', properties: {}, layout: {} },
            ],
          },
        },
      ],
    });
    const { received } = renderPreview();
    await waitFor(() => expect(received.length).toBeGreaterThan(0));

    act(() => {
      useEditorDomainStore.getState().setSelected('comp-3');
    });
    await flushMessages();
    received.length = 0;

    // What a shift-click on 'comp-1' does with 'comp-3' anchored.
    act(() => {
      useEditorDomainStore
        .getState()
        .setSelectedMany(['comp-1', 'comp-2', 'comp-3'], null, 'comp-3');
    });
    await flushMessages();

    const selections = received.filter((m) => m.type === 'set_selected');
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      ids: ['comp-1', 'comp-2', 'comp-3'],
      lead: 'comp-1',
    });
  });

  it('extends the selection on a ctrl/cmd-clicked component_clicked', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              { id: 'comp-1', type: 'Button', name: 'One', properties: {}, layout: {} },
              { id: 'comp-2', type: 'Button', name: 'Two', properties: {}, layout: {} },
            ],
          },
        },
      ],
    });
    const { iframe } = renderPreview();
    act(() => {
      dispatchFromIframe(iframe, { type: 'component_clicked', id: 'comp-1', pathIds: ['comp-1'] });
    });

    act(() => {
      dispatchFromIframe(iframe, {
        type: 'component_clicked',
        id: 'comp-2',
        pathIds: ['comp-2'],
        toggle: true,
      });
    });

    await waitFor(() => {
      expect(useEditorDomainStore.getState().selectedIds).toEqual(['comp-1', 'comp-2']);
    });
  });

  it('replaces the selection when the click carries no modifier', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              { id: 'comp-1', type: 'Button', name: 'One', properties: {}, layout: {} },
              { id: 'comp-2', type: 'Button', name: 'Two', properties: {}, layout: {} },
            ],
          },
        },
      ],
    });
    useEditorDomainStore.getState().setSelectedMany(['comp-1', 'comp-2']);
    const { iframe } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, { type: 'component_clicked', id: 'comp-2', pathIds: ['comp-2'] });
    });

    await waitFor(() => {
      expect(useEditorDomainStore.getState().selectedIds).toEqual(['comp-2']);
    });
  });

  it('opens an add menu on preview_context_menu and inserts into the resolved container', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              {
                id: 'box',
                type: 'Container',
                name: 'Box',
                properties: {},
                children: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {} }],
              },
            ],
          },
        },
      ],
    });
    const { iframe, getByText } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, {
        type: 'preview_context_menu',
        pathIds: ['comp-1', 'box'],
        x: 10,
        y: 20,
      });
    });

    // The clicked leaf cannot host children, so its container takes the widget.
    await waitFor(() => expect(getByText('Add to Box')).toBeTruthy());

    act(() => {
      fireEvent.click(getByText('Add Container'));
    });

    const page = useConfigStore.getState().pages[0];
    const box = (page as { sections: Record<string, unknown[]> }).sections.main[0] as {
      children: { type: string }[];
    };
    expect(box.children.map((c) => c.type)).toEqual(['Button', 'Container']);
  });

  it('deletes the right-clicked widget, leaving its container as the add target', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              {
                id: 'box',
                type: 'Container',
                name: 'Box',
                properties: {},
                children: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {} }],
              },
            ],
          },
        },
      ],
    });
    const { iframe, getByText } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, {
        type: 'preview_context_menu',
        pathIds: ['comp-1', 'box'],
        x: 10,
        y: 20,
      });
    });

    await waitFor(() => expect(getByText('Add to Box')).toBeTruthy());
    // The clicked widget names its own section, so Copy/Delete are unambiguous.
    expect(getByText('Btn')).toBeTruthy();

    act(() => {
      fireEvent.click(getByText('Delete'));
    });

    const page = useConfigStore.getState().pages[0] as { sections: Record<string, unknown[]> };
    const box = page.sections.main[0] as { children: unknown[] };
    expect(box.children).toEqual([]);
    expect(useEditorDomainStore.getState().selectedId).toBeNull();
  });

  it('drops a selected child that went with its deleted container', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [
              {
                id: 'box',
                type: 'Container',
                name: 'Box',
                properties: {},
                children: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {} }],
              },
            ],
          },
        },
      ],
    });
    // Lead is the child, but the delete acts on the container that already covers it.
    useEditorDomainStore.getState().setSelectedMany(['box', 'comp-1']);
    const { iframe, getByText } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, {
        type: 'preview_context_menu',
        pathIds: ['comp-1', 'box'],
        x: 10,
        y: 20,
      });
    });

    await waitFor(() => expect(getByText('Delete')).toBeTruthy());
    act(() => {
      fireEvent.click(getByText('Delete'));
    });

    const page = useConfigStore.getState().pages[0] as { sections: Record<string, unknown[]> };
    expect(page.sections.main).toEqual([]);
    expect(useEditorDomainStore.getState().selectedIds).toEqual([]);
    expect(useEditorDomainStore.getState().selectedId).toBeNull();
  });

  it('copies the right-clicked widget to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const widget = { id: 'comp-1', type: 'Button', name: 'Btn', properties: {} };
    useConfigStore.setState({
      pages: [{ id: 'page1', type: 'page', title: 'Home', sections: { main: [widget] } }],
    });
    const { iframe, getByText } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, {
        type: 'preview_context_menu',
        pathIds: ['comp-1'],
        x: 1,
        y: 1,
      });
    });

    await waitFor(() => expect(getByText('Copy')).toBeTruthy());
    act(() => {
      fireEvent.click(getByText('Copy'));
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(widget)));
  });

  it('offers no widget actions when the right-click misses every widget', async () => {
    const { iframe, getByText, queryByText } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, { type: 'preview_context_menu', pathIds: [], x: 5, y: 5 });
    });

    await waitFor(() => expect(getByText('Add to Home')).toBeTruthy());
    expect(queryByText('Copy')).toBeNull();
    expect(queryByText('Delete')).toBeNull();
    expect(getByText('Paste')).toBeTruthy();
  });

  it('switches the active tab on preview_location when the reported page differs', () => {
    useConfigStore.setState({
      pages: [
        { id: 'page1', type: 'page', title: 'Home', sections: { main: [] } },
        { id: 'page2', type: 'page', title: 'Other', sections: { main: [] } },
      ],
    });
    const { iframe } = renderPreview();

    act(() => {
      dispatchFromIframe(iframe, { type: 'preview_location', pageId: 'page2' });
    });

    expect(useEditorDomainStore.getState().previewAreaId).toBe('page2');
    expect(useEditorDomainStore.getState().activeTabId).toBe('page2');
  });

  it('stops listening for messages after unmount', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page1',
          type: 'page',
          title: 'Home',
          sections: {
            main: [{ id: 'comp-1', type: 'Button', name: 'Btn', properties: {}, layout: {} }],
          },
        },
      ],
    });
    const { iframe, unmount } = renderPreview();
    const contentWindow = iframe.contentWindow;
    unmount();

    const event = new MessageEvent('message', {
      data: { type: 'component_clicked', id: 'comp-1', pathIds: ['comp-1'] },
      origin: ORIGIN,
      source: contentWindow,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    // If the listener had survived unmount, this would resolve to 'comp-1'
    // (proven by the "accepts a same-origin…" case above using an identical fixture).
    expect(useEditorDomainStore.getState().selectedId).toBeNull();
  });
});
