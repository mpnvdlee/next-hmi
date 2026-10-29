import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Badge from './index';

function renderBadge(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Badge properties={properties}>
        <span>first</span>
        <span>second</span>
      </Badge>
    </MemoryRouter>,
  );
}

describe('Badge', () => {
  it.each([
    [3, '3'],
    ['NEW', 'NEW'],
  ])('shows a badge of %s next to its child', (badge, text) => {
    const { container } = renderBadge({ badge });

    expect(container.querySelector('.hmi-badge__chip')).toHaveTextContent(text);
    expect(container.querySelector('.hmi-badge')).toHaveTextContent(`first${text}`);
  });

  it('renders only its first child', () => {
    const { container } = renderBadge({});

    expect(container.querySelector('.hmi-badge')).toHaveTextContent(/^first$/);
  });

  it('passes color, offset and size to the chip as custom properties', () => {
    const { container } = renderBadge({ badge: 3, color: '#0a0', offset: -4, size: 16 });

    const chip = container.querySelector<HTMLElement>('.hmi-badge__chip');
    expect(chip?.style.getPropertyValue('--hmi-badge-color')).toBe('#0a0');
    expect(chip?.style.getPropertyValue('--hmi-badge-offset')).toBe('-4px');
    expect(chip?.style.getPropertyValue('--hmi-badge-size')).toBe('16px');
  });

  it.each([0, '', '  '])('hides the badge for %j', (badge) => {
    const { container } = renderBadge({ badge });

    expect(container.querySelector('.hmi-badge__chip')).toBeNull();
  });
});
