import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import Breadcrumb from './index';

const PAGES = [
  { id: 'home', type: 'page' as const, title: 'Home Page' },
  {
    id: 'line',
    type: 'page-group' as const,
    title: 'Filling Line',
    children: [
      {
        id: 'station',
        type: 'page-group' as const,
        title: 'Station 2',
        children: [{ id: 'trends', type: 'page' as const, title: 'Trends' }],
      },
    ],
  },
];

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderBreadcrumb(properties: Record<string, unknown>, path = '/pages/trends') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumb properties={properties} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function segmentTexts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.hmi-breadcrumb__segment')].map((s) => s.textContent);
}

describe('Breadcrumb', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never });
  });

  it('renders with no properties set', () => {
    const { container } = renderBreadcrumb({});
    expect(container.querySelector('.hmi-breadcrumb')).not.toBeNull();
  });

  it('roots itself in a labelled nav carrying both component classes', () => {
    const { container } = renderBreadcrumb({});
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('NAV');
    expect(root.className).toContain('hmi-component');
    expect(root.className).toContain('hmi-breadcrumb');
    expect(root).toHaveAttribute('aria-label', 'breadcrumb');
  });

  it('builds one segment per ancestor, ending at the active page', () => {
    const { container } = renderBreadcrumb({});
    expect(segmentTexts(container)).toEqual(['Filling Line', 'Station 2', 'Trends']);
  });

  it('links every ancestor and leaves the active page unclickable', () => {
    renderBreadcrumb({});
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Filling Line',
      'Station 2',
    ]);
    const current = screen.getByText('Trends');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('navigates to the ancestor behind a segment on click', async () => {
    const user = userEvent.setup();
    renderBreadcrumb({});
    await user.click(screen.getByRole('button', { name: 'Station 2' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/station');
  });

  it('puts one separator between each pair of segments', () => {
    const { container } = renderBreadcrumb({});
    const separators = container.querySelectorAll('.hmi-breadcrumb__separator');
    expect(separators).toHaveLength(2);
    expect(separators[0].textContent).toBe(' / ');
    expect(separators[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses the configured separator', () => {
    const { container } = renderBreadcrumb({ separator: ' › ' });
    expect(container.querySelector('.hmi-breadcrumb__separator')?.textContent).toBe(' › ');
  });

  it('prepends a home segment when a home page is configured', () => {
    const { container } = renderBreadcrumb({ showHomeIcon: true, homePageId: 'home' });
    expect(segmentTexts(container)).toEqual(['Home', 'Filling Line', 'Station 2', 'Trends']);
  });

  // `showHomeIcon` and its label both promise an icon; for a long time the
  // home segment rendered text only.
  it('renders a house icon on the home segment', async () => {
    const { container } = renderBreadcrumb({ showHomeIcon: true, homePageId: 'home' });
    // Builtin icon components are code-split — the first on-the-fly transform of
    // `phosphorIconComponents` can outlast waitFor's 1s default under parallel load.
    await waitFor(
      () => {
        expect(container.querySelector('.hmi-breadcrumb__icon svg')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    // Only the home segment carries one.
    expect(container.querySelectorAll('.hmi-breadcrumb__icon')).toHaveLength(1);
  }, 15000);

  it('renders no icon when the home segment is absent', () => {
    const { container } = renderBreadcrumb({});
    expect(container.querySelector('.hmi-breadcrumb__icon')).toBeNull();
  });

  it('labels the home segment with the home label', () => {
    const { container } = renderBreadcrumb({
      showHomeIcon: true,
      homePageId: 'home',
      homeLabel: 'Start',
    });
    expect(segmentTexts(container)[0]).toBe('Start');
  });

  it('falls back to "Home" when the home label is blank', () => {
    const { container } = renderBreadcrumb({
      showHomeIcon: true,
      homePageId: 'home',
      homeLabel: '',
    });
    expect(segmentTexts(container)[0]).toBe('Home');
  });

  it('navigates to the home page from the home segment', async () => {
    const user = userEvent.setup();
    renderBreadcrumb({ showHomeIcon: true, homePageId: 'home' });
    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/home');
  });

  it('omits the home segment when no home page is configured', () => {
    const { container } = renderBreadcrumb({ showHomeIcon: true });
    expect(segmentTexts(container)).toEqual(['Filling Line', 'Station 2', 'Trends']);
  });

  it('omits the home segment when the home page is already the trail root', () => {
    const { container } = renderBreadcrumb({ showHomeIcon: true, homePageId: 'line' });
    expect(segmentTexts(container)).toEqual(['Filling Line', 'Station 2', 'Trends']);
  });

  it('omits the home segment when the home icon is off', () => {
    const { container } = renderBreadcrumb({ homePageId: 'home' });
    expect(segmentTexts(container)).toEqual(['Filling Line', 'Station 2', 'Trends']);
  });

  it('renders nothing when the active page has no trail', () => {
    const { container } = renderBreadcrumb({}, '/pages/unknown');
    expect(container.querySelector('.hmi-breadcrumb')).toBeNull();
  });

  it('renders the home segment alone, as current, when there is no trail', () => {
    const { container } = renderBreadcrumb(
      { showHomeIcon: true, homePageId: 'home' },
      '/pages/unknown',
    );
    const segments = container.querySelectorAll('.hmi-breadcrumb__segment');
    expect(segments).toHaveLength(1);
    expect(segments[0].textContent).toBe('Home');
    expect(segments[0]).toHaveAttribute('aria-current', 'page');
    expect(container.querySelector('.hmi-breadcrumb__separator')).toBeNull();
  });
});
