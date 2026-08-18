import '../../testSdk';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  PageGroupStackContext,
  type PageGroupStackEntry,
} from '@hmi/components/PageGroupStackContext';
import { useTranslationStore } from '@shared/store/translationStore';
import TabBar from './index';

const GROUP = {
  id: 'line',
  type: 'page-group' as const,
  title: 'Filling Line',
  children: [
    { id: 'overview', type: 'page' as const, title: 'Overview', icon: 'house', sections: {} },
    { id: 'trends', type: 'page' as const, title: 'Trends', sections: {} },
  ],
};

const onNavigate = vi.fn();

function renderTabBar(properties: Record<string, unknown>, activeId = 'overview') {
  const entry = {
    group: GROUP,
    activePage: GROUP.children.find((c) => c.id === activeId),
    onNavigate,
  } as unknown as PageGroupStackEntry;
  return render(
    <MemoryRouter>
      <PageGroupStackContext.Provider value={[entry]}>
        <TabBar properties={properties} />
      </PageGroupStackContext.Provider>
    </MemoryRouter>,
  );
}

describe('TabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one tab per sibling page and marks the active one', () => {
    const { container } = renderTabBar({});
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Trends']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(container.querySelector('.hmi-tab-bar')?.className).toContain('hmi-tab-bar--underline');
  });

  it('navigates to the page behind a tab on click', async () => {
    const user = userEvent.setup();
    renderTabBar({});
    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    expect(onNavigate).toHaveBeenCalledWith('trends');
  });

  it('applies the pill class when the pill variant is selected', () => {
    const { container } = renderTabBar({ variant: 'pill' });
    expect(container.querySelector('.hmi-tab-bar')?.className).toContain('hmi-tab-bar--pill');
  });

  it('falls back to the underline variant for an unknown value', () => {
    const { container } = renderTabBar({ variant: 'bogus' });
    expect(container.querySelector('.hmi-tab-bar')?.className).toContain('hmi-tab-bar--underline');
  });

  it('renders no page icons by default', () => {
    const { container } = renderTabBar({});
    expect(container.querySelector('.hmi-tab-bar__icon')).toBeNull();
  });

  it("renders each page's own icon when showIcons is on", async () => {
    const { container } = renderTabBar({ showIcons: true });

    // Builtin icon components are code-split: the lazy import pulls the whole
    // `phosphorIconComponents` module, whose first on-the-fly transform can
    // outlast waitFor's 1s default when the suite runs in parallel. See the
    // fuller note in ../../Content/Icon/index.test.tsx.
    await waitFor(
      () => {
        expect(container.querySelector('.hmi-tab-bar__icon svg')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    // Only the page that declares an icon gets one.
    expect(container.querySelectorAll('.hmi-tab-bar__icon')).toHaveLength(1);
  }, 15000);

  it('renders nothing outside a page group', () => {
    const { container } = render(
      <MemoryRouter>
        <TabBar properties={{}} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.hmi-tab-bar')).toBeNull();
  });

  // Tab labels go through `resolvePageTitle`, which reads the translation store
  // without subscribing. What re-renders this widget is `usePropString` →
  // `useEvalContext`, which does subscribe — so the reactivity is transitive and
  // would vanish if this component ever stopped reading a schema prop.
  it('re-labels its tabs when the language changes', async () => {
    useTranslationStore.setState({
      languages: [
        { code: 'en', label: 'English' },
        { code: 'nl', label: 'Nederlands' },
      ],
      translations: { 'tab.overview': { nl: 'Overzicht' } },
      activeLanguage: 'en',
    } as never);

    const localised = {
      ...GROUP,
      children: [{ ...GROUP.children[0], title: { $loc: 'tab.overview' } }],
    };
    const entry = {
      group: localised,
      activePage: localised.children[0],
      onNavigate,
    } as unknown as PageGroupStackEntry;

    render(
      <MemoryRouter>
        <PageGroupStackContext.Provider value={[entry]}>
          <TabBar properties={{}} />
        </PageGroupStackContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('tab')).toHaveTextContent('tab.overview');

    act(() => {
      useTranslationStore.setState({ activeLanguage: 'nl' } as never);
    });
    await waitFor(() => {
      expect(screen.getByRole('tab')).toHaveTextContent('Overzicht');
    });
  });
});
