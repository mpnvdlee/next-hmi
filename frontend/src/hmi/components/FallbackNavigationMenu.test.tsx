// The menu is a built-in module — bind the SDK so jsdom can resolve it.
import '../../../widgets/testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { widgetRegistry } from '../registry/widgetRegistry';
import FallbackNavigationMenu from './FallbackNavigationMenu';

/**
 * The zero-config sidebar is the one place the app renders a widget the page
 * tree never named, so it cannot import the module (there is none to import) and
 * cannot go through `WidgetRenderer` (there is no node). It reads the registry
 * instead — which is exactly the coupling worth pinning.
 */
describe('FallbackNavigationMenu', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [{ id: 'first', type: 'page', title: 'First page', sections: { content: [] } }],
      header: [],
      footer: [],
      dialogs: [],
      loaded: true,
    });
  });

  it('renders the registered navigation menu', async () => {
    render(
      <MemoryRouter initialEntries={['/pages/first']}>
        <FallbackNavigationMenu />
      </MemoryRouter>,
    );

    // Lazy module: the first paint is empty, the menu arrives with it.
    expect(await screen.findByRole('button', { name: /First page/i })).toBeInTheDocument();
  });

  it('renders nothing when no navigation menu is registered', () => {
    const entry = widgetRegistry['NavigationMenu'];
    delete widgetRegistry['NavigationMenu'];
    try {
      const { container } = render(
        <MemoryRouter>
          <FallbackNavigationMenu />
        </MemoryRouter>,
      );
      expect(container).toBeEmptyDOMElement();
    } finally {
      widgetRegistry['NavigationMenu'] = entry;
    }
  });
});
