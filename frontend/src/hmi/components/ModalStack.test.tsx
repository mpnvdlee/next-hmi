import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore, type PageOverlayEntry } from '@hmi/store/hmiStore';
import type { PageConfig, PageNode } from '@shared/types/config';
import { PageGroupStackContext } from './PageGroupStackContext';
import { ModalStack } from './ModalStack';

// The overlay's page renders real widgets; a built-in is a lazy module jsdom
// cannot fetch, so the probe stands in for one.
vi.mock('@hmi/registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hmi/registry/widgetRegistry')>();
  const { LabeledProbe } = await import('./__fixtures__/probeWidgets');
  return {
    ...actual,
    widgetModulesLoaded: () => true,
    prefetchWidgetModules: () => Promise.resolve(),
    widgetRegistry: { ...actual.widgetRegistry, LabeledProbe },
  };
});

function placementPage(id: string): PageConfig {
  return { id, title: `Dialog ${id}`, type: 'page', sections: { content: [] } };
}

function overlayEntry(pageId: string, extra: Partial<PageOverlayEntry> = {}): PageOverlayEntry {
  return { pageId, componentProperties: {}, size: 'auto', placement: 'center', ...extra };
}

function openOverlayEntries(entries: PageOverlayEntry[]) {
  useHmiStore.setState({ openPageOverlays: entries });
}

function cardFor(container: HTMLElement, pageId: string): HTMLElement {
  // Cards render in DOM order matching openPageOverlays order; select by index via title text.
  const titles = Array.from(container.querySelectorAll('.hmi-modal__title'));
  const idx = titles.findIndex((t) => t.textContent === `Dialog ${pageId}`);
  return Array.from(container.querySelectorAll('.hmi-modal'))[idx] as HTMLElement;
}

describe('ModalStack page-overlay placement/size', () => {
  beforeEach(() => {
    useConfigStore.setState({ dialogs: [placementPage('a'), placementPage('b')], pages: [] });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  function renderOverlays() {
    return render(
      <MemoryRouter>
        <ModalStack />
      </MemoryRouter>,
    );
  }

  it('renders a default (center, no size) overlay as a plain in-flow card', () => {
    openOverlayEntries([overlayEntry('a')]);
    const { container } = renderOverlays();
    const card = cardFor(container, 'a');
    expect(card.className).toBe('hmi-modal');
  });

  it('docks an edge-placed overlay to the backdrop with a placement class', () => {
    openOverlayEntries([overlayEntry('a', { placement: 'top' })]);
    const { container } = renderOverlays();
    const card = cardFor(container, 'a');
    expect(card.className).toContain('hmi-modal--overlay');
    expect(card.className).toContain('hmi-modal--placement-top');
  });

  it('falls back to a centered card for a trigger placement with no captured anchor rect', () => {
    // e.g. fired from a global event / alert-modal replay, which has no trigger element.
    openOverlayEntries([overlayEntry('a', { placement: 'trigger-below' })]);
    const { container } = renderOverlays();
    const card = cardFor(container, 'a');
    expect(card.className).toBe('hmi-modal');
  });

  it('applies a size class to an edge-docked overlay', () => {
    openOverlayEntries([overlayEntry('a', { placement: 'left', size: 'medium' })]);
    const { container } = renderOverlays();
    const card = cardFor(container, 'a');
    expect(card.className).toContain('hmi-modal--size-medium');
  });

  it('offsets a second overlay docked at the same placement instead of overlapping it', () => {
    openOverlayEntries([
      overlayEntry('a', { placement: 'top' }),
      overlayEntry('b', { placement: 'top' }),
    ]);
    const { container } = renderOverlays();
    const cardA = cardFor(container, 'a');
    const cardB = cardFor(container, 'b');
    expect(cardA.style.getPropertyValue('--hmi-modal-stack-offset')).toBe('');
    expect(cardB.style.getPropertyValue('--hmi-modal-stack-offset')).toBe('16px');
  });

  it('keeps an in-flow card inside the stack, which is what tiles two of them', () => {
    // The stack owns the gap, padding and wrapping every centered auto-size card
    // lays out under — a card rendered straight onto the backdrop would overlap
    // the next one instead.
    openOverlayEntries([overlayEntry('a')]);
    const { container } = renderOverlays();
    expect(cardFor(container, 'a').parentElement?.className).toBe('hmi-modal-stack');
  });
});

// ── Close settings: the node the action named decides them ───────────────────

describe('ModalStack overlay close settings', () => {
  const sealed = (id: string): PageConfig => ({
    ...placementPage(id),
    showCloseButton: false,
    closeOnBackgroundPress: false,
  });

  function renderOverlays() {
    return render(
      <MemoryRouter>
        <ModalStack />
      </MemoryRouter>,
    );
  }

  function clickBackdrop(container: HTMLElement) {
    act(() => {
      (container.querySelector('.hmi-modal-backdrop') as HTMLElement).click();
    });
  }

  beforeEach(() => {
    useConfigStore.setState({
      pages: [sealed('nav')],
      dialogs: [placementPage('a'), sealed('shut')],
    });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  it('shows the close button and closes on the backdrop by default', () => {
    openOverlayEntries([overlayEntry('a')]);
    const { container } = renderOverlays();

    expect(container.querySelector('.hmi-modal__close')).not.toBeNull();
    clickBackdrop(container);
    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
  });

  it('honours a Dialogs-folder page that turns the close button off', () => {
    // The migration writes both flags explicitly for every old dialog, so this
    // is what keeps a dialog that had neither behaving as it did.
    openOverlayEntries([overlayEntry('shut')]);
    const { container } = renderOverlays();

    expect(container.querySelector('.hmi-modal__close')).toBeNull();
  });

  it('honours a Dialogs-folder page that turns the backdrop press off', () => {
    openOverlayEntries([overlayEntry('shut')]);
    const { container } = renderOverlays();

    clickBackdrop(container);
    expect(useHmiStore.getState().openPageOverlays).toHaveLength(1);
  });

  it('ignores both flags on a page outside the Dialogs folder', () => {
    // An ordinary page borrowed as an overlay closes both ways whatever its
    // file happens to store.
    openOverlayEntries([overlayEntry('nav')]);
    const { container } = renderOverlays();

    expect(container.querySelector('.hmi-modal__close')).not.toBeNull();
    clickBackdrop(container);
    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
  });

  it('follows the node the action named, not the page navigated to inside it', () => {
    // `pageId` is the overlay's identity; a tab switch moves `activePageId`
    // only, and the card must keep the settings the action's target declared.
    useConfigStore.setState({
      dialogs: [
        {
          id: 'grp',
          title: 'Group',
          type: 'page-group',
          showCloseButton: false,
          closeOnBackgroundPress: false,
          children: [placementPage('a')],
        } as unknown as PageNode,
      ],
    });
    openOverlayEntries([overlayEntry('grp', { activePageId: 'a' })]);
    const { container } = renderOverlays();

    expect(container.querySelector('.hmi-modal__close')).toBeNull();
    clickBackdrop(container);
    expect(useHmiStore.getState().openPageOverlays).toHaveLength(1);
  });
});

// ── Title: the node the action named decides it too ──────────────────────────

describe('ModalStack overlay title', () => {
  beforeEach(() => {
    useConfigStore.setState({
      dialogs: [
        {
          id: 'grp',
          title: 'Group',
          type: 'page-group',
          children: [placementPage('a'), placementPage('b')],
        } as unknown as PageNode,
      ],
      pages: [],
    });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  function renderOverlays() {
    return render(
      <MemoryRouter>
        <ModalStack />
      </MemoryRouter>,
    );
  }

  it('keeps the group title fixed across an in-overlay tab switch', () => {
    openOverlayEntries([overlayEntry('grp')]);
    const { container } = renderOverlays();
    expect(container.querySelector('.hmi-modal__title')?.textContent).toBe('Group');

    // A real in-overlay navigation moves `activePageId`, same as a tab click
    // inside the group chrome would.
    act(() => {
      useHmiStore.getState().updatePageOverlay('grp', 'a');
    });
    expect(container.querySelector('.hmi-modal__title')?.textContent).toBe('Group');

    act(() => {
      useHmiStore.getState().updatePageOverlay('grp', 'b');
    });
    expect(container.querySelector('.hmi-modal__title')?.textContent).toBe('Group');
  });
});

// ── Page-overlay input properties ────────────────────────────────────────────

function probePage(id: string, title: string, declared?: PageConfig['componentProperties']) {
  return {
    id,
    title,
    type: 'page' as const,
    sections: {
      content: [
        {
          id: `${id}-w`,
          type: 'LabeledProbe',
          name: 'Probe',
          properties: { label: { $componentProp: 'motorId' } },
        },
      ],
    },
    ...(declared ? { componentProperties: declared } : {}),
  } satisfies PageConfig;
}

const DECLARED = { motorId: { type: 'String', label: 'Motor', defaultValue: 'M1' } };

describe('ModalStack page overlays — input properties', () => {
  beforeEach(() => {
    useConfigStore.setState({
      // Only a Dialogs-folder target grants an input scope — see
      // `closeSettings`/`PageOverlayBody`'s `takesInputs={root === 'dialogs'}`
      // in ModalStack.tsx.
      dialogs: [probePage('ov1', 'Overlay', DECLARED), probePage('ov2', 'Sibling')],
      pages: [probePage('ov3', 'Plain page', DECLARED)],
      loadedPageIds: new Set(['ov1', 'ov2', 'ov3']),
    });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  function renderOverlay() {
    return render(
      <MemoryRouter>
        <ModalStack />
      </MemoryRouter>,
    );
  }

  it('publishes the values the action supplied to the overlay page', () => {
    useHmiStore.setState({
      openPageOverlays: [
        {
          pageId: 'ov1',
          componentProperties: { motorId: 'M7' },
          size: 'auto',
          placement: 'center',
        },
      ],
    });
    renderOverlay();
    // The supplied value wins over the declared default — the page's own
    // defaults-only scope must layer under the overlay's, never shadow it.
    expect(screen.getByRole('button', { name: 'M7' })).toBeInTheDocument();
  });

  it('falls back to the declared default for a parameter the action left unset', () => {
    useHmiStore.setState({
      openPageOverlays: [
        { pageId: 'ov1', componentProperties: {}, size: 'auto', placement: 'center' },
      ],
    });
    renderOverlay();
    expect(screen.getByRole('button', { name: 'M1' })).toBeInTheDocument();
  });

  it('keeps the values when the overlay navigates to a sibling page', () => {
    useHmiStore.setState({
      openPageOverlays: [
        {
          pageId: 'ov1',
          componentProperties: { motorId: 'M7' },
          size: 'auto',
          placement: 'center',
        },
      ],
    });
    renderOverlay();
    act(() => {
      useHmiStore.getState().updatePageOverlay('ov1', 'ov2');
    });
    // `pageId` is the overlay's identity and stays on the target the action
    // named; navigation moves `activePageId` instead.
    expect(useHmiStore.getState().openPageOverlays[0]).toMatchObject({
      pageId: 'ov1',
      activePageId: 'ov2',
      componentProperties: { motorId: 'M7' },
    });
    expect(screen.getByRole('button', { name: 'M7' })).toBeInTheDocument();
  });

  it('gives a page outside the Dialogs folder no input scope, even when the action supplies values', () => {
    useHmiStore.setState({
      openPageOverlays: [
        {
          pageId: 'ov3',
          componentProperties: { motorId: 'M7' },
          size: 'auto',
          placement: 'center',
        },
      ],
    });
    renderOverlay();
    // Neither the supplied value nor the page's own declared default reaches
    // it — `$componentProp` only resolves inside the Dialogs folder, so an
    // ordinary page opened as an overlay never gets an input scope at all.
    expect(screen.queryByRole('button', { name: 'M7' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'M1' })).not.toBeInTheDocument();
  });
});

// ── Page-group overlays and declaration precedence ───────────────────────────

function probe(id: string, propName: string) {
  return {
    id,
    type: 'LabeledProbe',
    name: 'Probe',
    properties: { label: { $componentProp: propName } },
  };
}

function decl(name: string, defaultValue: string) {
  return { [name]: { type: 'String', label: name, defaultValue } };
}

/** og(motorId=OUTER) > ig(motorId=INNER) > p1(motorId=PAGE, pageOnly=PAGE-ONLY).
 *  p2 declares nothing, p3 sits directly under the outer group. */
const GROUP_TREE: PageNode[] = [
  {
    id: 'og',
    title: 'Outer',
    type: 'page-group',
    componentProperties: decl('motorId', 'OUTER'),
    header: [probe('og-h', 'motorId')],
    children: [
      {
        id: 'ig',
        title: 'Inner',
        type: 'page-group',
        componentProperties: decl('motorId', 'INNER'),
        header: [probe('ig-h', 'motorId'), probe('ig-h2', 'pageOnly')],
        children: [
          {
            id: 'p1',
            title: 'One',
            type: 'page',
            componentProperties: { ...decl('motorId', 'PAGE'), ...decl('pageOnly', 'PAGE-ONLY') },
            sections: { content: [probe('p1-w', 'motorId'), probe('p1-w2', 'plant')] },
          },
          {
            id: 'p2',
            title: 'Two',
            type: 'page',
            sections: { content: [probe('p2-w', 'motorId')] },
          },
        ],
      },
      { id: 'p3', title: 'Three', type: 'page', sections: { content: [probe('p3-w', 'motorId')] } },
    ],
  },
] as unknown as PageNode[];

function openOverlay(pageId: string, componentProperties: Record<string, unknown>) {
  useHmiStore.setState({
    openPageOverlays: [{ pageId, componentProperties, size: 'auto', placement: 'center' }],
  });
}

/** Labels of the probes in the page body, in document order. */
function contentLabels(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.hmi-page__content button')].map((b) => b.textContent);
}

/** Labels of the probes in every page-group chrome band, outermost first. */
function chromeLabels(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.hmi-page-group-shell__header button')].map(
    (b) => b.textContent,
  );
}

describe('ModalStack page overlays — page groups take input properties too', () => {
  beforeEach(() => {
    useConfigStore.setState({
      // Only a Dialogs-folder target grants an input scope, at every level of
      // its group trail — see the mirror case below for a target outside it.
      dialogs: GROUP_TREE,
      pages: [],
      loadedPageIds: new Set(['p1', 'p2', 'p3']),
    });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  function renderOverlay() {
    return render(
      <MemoryRouter>
        <ModalStack />
      </MemoryRouter>,
    );
  }

  it('lets the supplied value beat every declared default', () => {
    openOverlay('p1', { motorId: 'M7' });
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).toBe('M7');
  });

  it("prefers the page's own default to the groups it sits in", () => {
    openOverlay('p1', {});
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).toBe('PAGE');
  });

  it("prefers the inner group's default to the outer group's", () => {
    openOverlay('p2', {});
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).toBe('INNER');
  });

  it("falls back to the outer group's default when nothing inner declares the name", () => {
    openOverlay('p3', {});
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).toBe('OUTER');
  });

  it('keeps an explicit null set through every layer of defaults', () => {
    // `null` is an author clearing a field on purpose; only `undefined` falls
    // through to a default, at the page level and at every group above it.
    openOverlay('p1', { motorId: null });
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).toBe('');
  });

  it('opens a page group as the active child inside the group chrome', () => {
    openOverlay('og', {});
    const { container } = renderOverlay();
    expect(chromeLabels(container)).toEqual(['OUTER', 'INNER', '']);
    expect(contentLabels(container)[0]).toBe('PAGE');
  });

  it("hands group chrome the supplied values but never the active page's declarations", () => {
    // The `pageOnly` probe sits in the inner group's header: the page declares
    // that name, the chrome renders outside the page, so it reads nothing.
    openOverlay('og', { motorId: 'M7' });
    const { container } = renderOverlay();
    expect(chromeLabels(container)).toEqual(['M7', 'M7', '']);
  });

  it('keeps a group overlay’s values while the operator switches child pages', () => {
    openOverlay('og', { motorId: 'M7' });
    const { container } = renderOverlay();
    act(() => {
      useHmiStore.getState().updatePageOverlay('og', 'p2');
    });
    expect(useHmiStore.getState().openPageOverlays[0]).toMatchObject({
      pageId: 'og',
      activePageId: 'p2',
      componentProperties: { motorId: 'M7' },
    });
    expect(contentLabels(container)[0]).toBe('M7');
    expect(chromeLabels(container)).toEqual(['M7', 'M7', '']);
  });

  it('closes a group overlay by the group id after the operator changed page', () => {
    openOverlay('og', {});
    renderOverlay();
    act(() => {
      useHmiStore.getState().updatePageOverlay('og', 'p2');
      useHmiStore.getState().closePageOverlay('og');
    });
    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
  });

  it('ignores the background page’s groups carried on PageGroupStackContext', () => {
    // Inside an overlay that context still holds the host page's trail. Those
    // groups decorate a different page and must contribute no declarations —
    // `plant` is declared only there, so the probe reading it stays blank.
    const backgroundGroup = {
      id: 'bg',
      title: 'Background',
      type: 'page-group',
      componentProperties: { ...decl('plant', 'BG-PLANT'), ...decl('motorId', 'BG') },
      children: [],
    } as unknown as Extract<PageNode, { type: 'page-group' }>;
    openOverlay('og', {});
    const { container } = render(
      <MemoryRouter>
        <PageGroupStackContext.Provider
          value={[{ group: backgroundGroup, activePage: backgroundGroup, onNavigate: () => {} }]}
        >
          <ModalStack />
        </PageGroupStackContext.Provider>
      </MemoryRouter>,
    );
    expect(contentLabels(container)).toEqual(['PAGE', '']);
    // The chrome scopes line up with the overlay's own trail, not with the
    // stack the background page prefixed onto it.
    expect(chromeLabels(container)).toEqual(['OUTER', 'INNER', '']);
  });

  it('gives a page-group tree outside the Dialogs folder no input scope at any level', () => {
    // Same GROUP_TREE, opened from `pages:` instead of `dialogs:` — every
    // level's declared default and the supplied value alike go unresolved.
    useConfigStore.setState({ dialogs: [], pages: GROUP_TREE });
    openOverlay('p1', { motorId: 'M7' });
    const { container } = renderOverlay();
    expect(contentLabels(container)[0]).not.toBe('M7');
    expect(contentLabels(container)[0]).not.toBe('PAGE');
  });
});

// Store-level identity rules. An overlay answers to two ids — the node the
// action named (`pageId`) and the page it currently shows (`activePageId`) —
// and opening, collapsing and closing each have to agree on that, or a card
// stacks twice or one close removes two overlays.
describe('page-overlay identity — open / collapse / close', () => {
  const entry = (pageId: string, activePageId?: string) => ({
    pageId,
    ...(activePageId ? { activePageId } : {}),
    componentProperties: {},
    size: 'auto' as const,
    placement: 'center' as const,
  });

  beforeEach(() => {
    useHmiStore.setState({ openPageOverlays: [] });
  });

  it('refuses to open a page another overlay has navigated onto', () => {
    useHmiStore.setState({ openPageOverlays: [entry('og', 'p2')] });
    act(() => {
      useHmiStore.getState().openPageOverlay(entry('p2'));
    });
    expect(useHmiStore.getState().openPageOverlays).toHaveLength(1);
  });

  it('collapses onto an overlay that has navigated to the target page', () => {
    useHmiStore.setState({ openPageOverlays: [entry('og', 'p2'), entry('p1')] });
    act(() => {
      useHmiStore.getState().updatePageOverlay('p1', 'p2');
    });
    const open = useHmiStore.getState().openPageOverlays;
    expect(open).toHaveLength(1);
    expect(open[0].pageId).toBe('og');
  });

  it('closes by the active child id after a tab switch', () => {
    useHmiStore.setState({ openPageOverlays: [entry('og', 'p2')] });
    act(() => {
      useHmiStore.getState().closePageOverlay('p2');
    });
    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
  });

  it('closes only the topmost overlay when an id could match two', () => {
    // Not reachable through the open guard, but the close path matches on two
    // fields — if the invariant ever slipped, closing both would take away an
    // overlay the operator never named.
    useHmiStore.setState({ openPageOverlays: [entry('p2'), entry('og', 'p2')] });
    act(() => {
      useHmiStore.getState().closePageOverlay('p2');
    });
    const open = useHmiStore.getState().openPageOverlays;
    expect(open).toHaveLength(1);
    expect(open[0].pageId).toBe('p2');
  });
});
