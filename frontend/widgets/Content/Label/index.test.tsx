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
        <Label properties={{ text: 'AQUAVANE', size: '17px', weight: 800, color: '#123456' }} />
      </MemoryRouter>,
    );
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-label-size')).toBe('17px');
    expect(el.style.getPropertyValue('--hmi-label-weight')).toBe('800');
    expect(el.style.getPropertyValue('--hmi-label-color')).toBe('#123456');
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
  });

  it('resolves the text through a property source', () => {
    render(
      <MemoryRouter>
        <Label properties={{ text: { $static: 'From a source' } }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('From a source')).toBeInTheDocument();
  });
});
