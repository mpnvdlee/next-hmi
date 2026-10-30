import { applyThemeTokens, defaultTheme } from './themeTokens';

describe('applyThemeTokens — numpad', () => {
  const root = document.documentElement;

  it('writes the numpad tokens to :root and the column count as an attribute', () => {
    const theme = defaultTheme();
    theme.numpad = { ...theme.numpad, columns: 4, key_size: '64px', accent: '#ff0000' };

    applyThemeTokens(theme);

    expect(root.style.getPropertyValue('--hmi-numpad-key-size')).toBe('64px');
    expect(root.style.getPropertyValue('--hmi-numpad-accent')).toBe('#ff0000');
    expect(root.style.getPropertyValue('--hmi-numpad-columns')).toBe('4');
    expect(root.getAttribute('data-hmi-numpad-columns')).toBe('4');
  });

  it('leaves empty numpad tokens to the stylesheet fallbacks and defaults to 3 columns', () => {
    applyThemeTokens(defaultTheme());

    expect(root.style.getPropertyValue('--hmi-numpad-key-size')).toBe('');
    expect(root.style.getPropertyValue('--hmi-numpad-key-font-weight')).toBe('');
    expect(root.getAttribute('data-hmi-numpad-columns')).toBe('3');
  });
});
