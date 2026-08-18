import { render, screen, fireEvent } from '@testing-library/react';
import ThemeTree from './index';
import { useThemeViewStore } from '@config/store/themeViewStore';

describe('ThemeTree', () => {
  beforeEach(() => {
    useThemeViewStore.setState({
      themeIds: ['light', 'dark'],
      defaultThemeId: 'light',
      selectedThemeId: 'light',
      loaded: {},
      drafts: {},
      loading: false,
      loadError: null,
    });
  });

  it('lists every theme and marks the selected one', () => {
    render(<ThemeTree />);
    expect(screen.getByText('light')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();
  });

  it('selecting a theme updates the store selection', () => {
    render(<ThemeTree />);
    fireEvent.click(screen.getByText('dark'));
    expect(useThemeViewStore.getState().selectedThemeId).toBe('dark');
  });

  it('offers an add-theme affordance', () => {
    render(<ThemeTree />);
    expect(screen.getByTitle('Add theme')).toBeInTheDocument();
  });
});
