import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Label from './index';

describe('Label', () => {
  it('renders nothing when the text is empty', () => {
    const { container } = render(
      <MemoryRouter>
        <Label properties={{ text: '' }} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('applies the typography combo, alignment and overflow classes', () => {
    const { container } = render(
      <MemoryRouter>
        <Label
          properties={{ text: 'Mix tank', typography: 'value', align: 'center', wrap: 'truncate' }}
        />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el).toHaveTextContent('Mix tank');
    expect(el.className).toMatch(/hmi-label--type-value/);
    expect(el.className).toMatch(/hmi-label--align-center/);
    expect(el.className).toMatch(/hmi-label--truncate/);
  });

  it('falls back to the body combo and left alignment for unknown values', () => {
    const { container } = render(
      <MemoryRouter>
        <Label properties={{ text: 'x', typography: 'nonsense', align: 'sideways' }} />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toMatch(/hmi-label--type-body/);
    expect(el.className).toMatch(/hmi-label--align-left/);
  });

  it('emits the size and weight overrides as custom properties, not literal styles', () => {
    const { container } = render(
      <MemoryRouter>
        <Label
          properties={{
            text: 'AQUAVANE',
            size: '17px',
            weight: 800,
            color: '#123456',
            padding: '4px 8px',
          }}
        />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-label-size')).toBe('17px');
    expect(el.style.getPropertyValue('--hmi-label-weight')).toBe('800');
    expect(el.style.getPropertyValue('--hmi-label-color')).toBe('#123456');
    expect(el.style.getPropertyValue('--hmi-label-padding')).toBe('4px 8px');
  });

  it('leaves the overrides unset when no size or weight is configured', () => {
    const { container } = render(
      <MemoryRouter>
        <Label properties={{ text: 'plain' }} />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-label-size')).toBe('');
    expect(el.style.getPropertyValue('--hmi-label-weight')).toBe('');
    expect(el.style.getPropertyValue('--hmi-label-padding')).toBe('');
  });

  it('resolves the text through a property source', () => {
    render(
      <MemoryRouter>
        <Label properties={{ text: { $static: 'From a source' } }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('From a source')).toBeInTheDocument();
  });

  it('emits line height, letter spacing and the unit style as custom properties', () => {
    const { container } = render(
      <MemoryRouter>
        <Label
          properties={{
            text: '12.4',
            lineHeight: '1',
            letterSpacing: '-0.02em',
            unit: 'g',
            unitSize: '15px',
            unitColor: 'var(--hmi-text)',
          }}
        />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-label-line-height')).toBe('1');
    expect(el.style.getPropertyValue('--hmi-label-tracking')).toBe('-0.02em');
    expect(el.style.getPropertyValue('--hmi-label-unit-size')).toBe('15px');
    expect(el.style.getPropertyValue('--hmi-label-unit-color')).toBe('var(--hmi-text)');
    expect(el).toHaveTextContent('12.4 g');
    expect(el.querySelector('.hmi-label__unit')).toHaveTextContent('g');
  });

  it('renders the text alone without a unit', () => {
    const { container } = render(
      <MemoryRouter>
        <Label properties={{ text: '12.4' }} />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.textContent).toBe('12.4');
    expect(el.querySelector('.hmi-label__unit')).toBeNull();
    expect(el.style.getPropertyValue('--hmi-label-line-height')).toBe('');
    expect(el.style.getPropertyValue('--hmi-label-tracking')).toBe('');
  });
});
