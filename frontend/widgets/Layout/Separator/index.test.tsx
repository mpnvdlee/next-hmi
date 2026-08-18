import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Separator from './index';

describe('Separator', () => {
  it('defaults to a 1px horizontal rule', () => {
    render(
      <MemoryRouter>
        <Separator properties={{}} />
      </MemoryRouter>,
    );
    const el = screen.getByRole('separator');

    expect(el).toHaveAttribute('aria-orientation', 'horizontal');
    expect(el.className).toMatch(/horizontal/);
    expect(el.style.getPropertyValue('--hmi-separator-thickness')).toBe('1px');
  });

  it('switches orientation and carries thickness, colour and inset as custom properties', () => {
    render(
      <MemoryRouter>
        <Separator
          properties={{ orientation: 'vertical', thickness: 3, color: '#abc', inset: 8 }}
        />
      </MemoryRouter>,
    );
    const el = screen.getByRole('separator');

    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el.className).toMatch(/vertical/);
    expect(el.style.getPropertyValue('--hmi-separator-thickness')).toBe('3px');
    expect(el.style.getPropertyValue('--hmi-separator-color')).toBe('#abc');
    expect(el.style.getPropertyValue('--hmi-separator-inset')).toBe('8px');
  });

  it('leaves the inset unset at zero so the CSS default applies', () => {
    render(
      <MemoryRouter>
        <Separator properties={{ inset: 0 }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('separator').style.getPropertyValue('--hmi-separator-inset')).toBe('');
  });
});
