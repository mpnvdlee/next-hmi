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

describe('applyThemeTokens — toasts', () => {
  const root = document.documentElement;

  it('writes position and shape as attributes and the severity colours as tokens', () => {
    const theme = defaultTheme();
    theme.toasts = {
      ...theme.toasts,
      position: 'bottom-right',
      shape: 'pill',
      error_bg: '#b91c1c',
    };

    applyThemeTokens(theme);

    expect(root.getAttribute('data-hmi-toast-position')).toBe('bottom-right');
    expect(root.getAttribute('data-hmi-toast-shape')).toBe('pill');
    expect(root.style.getPropertyValue('--hmi-toast-error-bg')).toBe('#b91c1c');
  });

  it("defaults to today's look: top-center, rounded, empty colours left to the stylesheet", () => {
    applyThemeTokens(defaultTheme());

    expect(root.getAttribute('data-hmi-toast-position')).toBe('top-center');
    expect(root.getAttribute('data-hmi-toast-shape')).toBe('rounded');
    expect(root.style.getPropertyValue('--hmi-toast-info-bg')).toBe('');
    expect(root.style.getPropertyValue('--hmi-toast-error-text')).toBe('');
  });
});
