import { useLayoutEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { PageConfig, WidgetConfig } from '@shared/types/config';
import PageGroupPageView from './PageGroupPageView';

// A widget module that never lands on its own, so the two waits can be driven
// one at a time. Only the two prefetch helpers are stubbed — WidgetRenderer
// still needs the real registry.
let landModules: (() => void) | undefined;
let modulesInMemory = false;
let lastWaitedOn: WidgetConfig[] = [];
vi.mock('@hmi/registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hmi/registry/widgetRegistry')>();
  return {
    ...actual,
    widgetModulesLoaded: (nodes: WidgetConfig[]) => {
      lastWaitedOn = nodes;
      return modulesInMemory;
    },
    prefetchWidgetModules: (nodes: WidgetConfig[]) => {
      lastWaitedOn = nodes;
      return new Promise<void>((resolve) => {
        landModules = () => resolve();
      });
    },
  };
});

function isSpinnerShown(): boolean {
  return screen.queryByRole('status') !== null;
}

/** Captures the DOM as first committed: layout effects run during the same
 *  commit, before the passive effects that could still change the answer. */
function FirstFrameProbe({ onFrame }: { onFrame: (html: string) => void }) {
  useLayoutEffect(() => {
    onFrame(document.querySelector('.hmi-page')?.innerHTML ?? '');
    // Deliberately once, on mount: later commits are not the frame under test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// Empty content on purpose: the stubs above decide when the modules land, and
// a real widget would raise the *content* boundary's spinner while its own
// module loaded — indistinguishable here from the gate's.
const PAGE: PageConfig = {
  id: 'p1',
  title: 'Page p1',
  type: 'page',
  sections: { content: [] },
};

describe('PageGroupPageView / PageContent — the module wait', () => {
  beforeEach(() => {
    landModules = undefined;
    modulesInMemory = false;
    lastWaitedOn = [];
    useConfigStore.setState({ loadedPageIds: new Set(['p1', 'p2']) });
    useVariableStore.setState({
      values: {},
      varMeta: {},
      snapshotReceived: true,
      contextReadyPageIds: [],
      wsConnected: true,
      opcuaConnected: {},
    });
  });

  it('reveals the moment the modules land, with no variables in the store', async () => {
    vi.useFakeTimers();
    try {
      render(
        <MemoryRouter>
          <PageGroupPageView pages={[PAGE]} requestedId="p1" onNavigate={() => {}} />
        </MemoryRouter>,
      );
      expect(isSpinnerShown()).toBe(true);

      // Time alone changes nothing: the page is waiting on its code.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(isSpinnerShown()).toBe(true);

      // Modules in. No context_ready, no values — the page shows anyway; a
      // binding without data is the settle gate's problem, not the reveal's.
      await act(async () => {
        landModules?.();
      });
      expect(isSpinnerShown()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals on its own if the modules never land at all', async () => {
    vi.useFakeTimers();
    try {
      render(
        <MemoryRouter>
          <PageGroupPageView pages={[PAGE]} requestedId="p1" onNavigate={() => {}} />
        </MemoryRouter>,
      );
      expect(isSpinnerShown()).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(isSpinnerShown()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits again on a page whose earlier wait expired', async () => {
    vi.useFakeTimers();
    const P2: PageConfig = { id: 'p2', title: 'Page p2', type: 'page', sections: { content: [] } };
    try {
      const { rerender } = render(
        <MemoryRouter>
          <PageGroupPageView pages={[PAGE, P2]} requestedId="p1" onNavigate={() => {}} />
        </MemoryRouter>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(isSpinnerShown()).toBe(false);

      const goTo = (id: string) =>
        rerender(
          <MemoryRouter>
            <PageGroupPageView pages={[PAGE, P2]} requestedId={id} onNavigate={() => {}} />
          </MemoryRouter>,
        );
      await act(async () => goTo('p2'));
      await act(async () => goTo('p1'));

      // PageContent is not remounted between pages, so a latched "the wait
      // expired" would otherwise reveal p1 half-built on every later visit.
      expect(isSpinnerShown()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the page, not the spinner, on the very first frame when the modules are in memory', () => {
    modulesInMemory = true;
    let firstFrame = '';
    render(
      <MemoryRouter>
        <PageGroupPageView pages={[PAGE]} requestedId="p1" onNavigate={() => {}} />
        <FirstFrameProbe onFrame={(html) => (firstFrame = html)} />
      </MemoryRouter>,
    );
    // A gate answered only from a passive effect paints the body spinner for
    // this frame on every navigation back to an already-visited page.
    expect(firstFrame).toContain('hmi-page__content');
    expect(firstFrame).not.toContain('app-spinner');
  });

  it('does not wait on a band the page does not render', () => {
    const headerWidget: WidgetConfig = { id: 'h1', type: 'Label', name: 'h1' };
    const contentWidget: WidgetConfig = { id: 'c1', type: 'Label', name: 'c1' };
    render(
      <MemoryRouter>
        <PageGroupPageView
          pages={[
            {
              ...PAGE,
              showHeader: false,
              sections: { header: [headerWidget], content: [contentWidget] },
            },
          ]}
          requestedId="p1"
          onNavigate={() => {}}
        />
      </MemoryRouter>,
    );
    expect(lastWaitedOn.map((n) => n.id)).toEqual(['c1']);
  });
});
