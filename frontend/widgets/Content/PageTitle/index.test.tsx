import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import PageTitle from './index';

const PAGES = [
  { id: 'dashboard', type: 'page' as const, title: 'Dashboard', icon: 'house' },
  { id: 'line', type: 'page' as const, title: 'Filling Line' },
];

function renderTitle(properties: Record<string, unknown>, path = '/pages/line') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PageTitle properties={properties} />
    </MemoryRouter>,
  );
}

describe('PageTitle', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never });
  });

  it("falls back to the active page's title", () => {
    renderTitle({});
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Filling Line');
  });

  it('renders the override text instead of the page title', () => {
    renderTitle({ text: 'Overview' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Overview');
  });

  it('renders a subtitle beside the title', () => {
    const { container } = renderTitle({ text: 'Overview', subtitle: 'Line 2 status' });
    expect(container.querySelector('.hmi-page-title__subtitle')?.textContent).toBe('Line 2 status');
  });

  it('renders the subtitle alone when the title resolves empty', () => {
    useConfigStore.setState({ pages: [] });
    const { container } = renderTitle({ subtitle: 'Line 2 status' }, '/');
    expect(container.querySelector('.hmi-page-title')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(container.querySelector('.hmi-page-title__subtitle')?.textContent).toBe('Line 2 status');
  });

  it('renders nothing when both the title and the subtitle are empty', () => {
    useConfigStore.setState({ pages: [] });
    const { container } = renderTitle({}, '/');
    expect(container.querySelector('.hmi-page-title')).toBeNull();
  });

  it("defaults the icon to the active page's icon", async () => {
    const { container } = renderTitle({}, '/pages/dashboard');

    // Builtin icon components are code-split: the lazy import pulls the whole
    // `phosphorIconComponents` module, whose first on-the-fly transform can
    // outlast waitFor's 1s default when the suite runs in parallel. See the
    // fuller note in ../Icon/index.test.tsx.
    await waitFor(
      () => {
        expect(container.querySelector('.hmi-page-title__icon svg')).not.toBeNull();
      },
      { timeout: 8000 },
    );
  }, 15000);

  it('renders no icon when neither the page nor the property names one', () => {
    const { container } = renderTitle({});
    expect(container.querySelector('.hmi-page-title__icon')).toBeNull();
  });
});
