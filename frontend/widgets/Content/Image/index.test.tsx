import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Image from './index';

function renderImage(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Image properties={properties} />
    </MemoryRouter>,
  );
}

describe('Image', () => {
  it('renders an img element resolved from the src property', () => {
    renderImage({ src: '/assets/images/plant.png', alt: 'Plant overview' });

    const img = screen.getByRole('img', { name: 'Plant overview' });
    expect(img).toHaveAttribute('src', '/assets/images/plant.png');
  });

  it('shows a placeholder when no src is set', () => {
    renderImage({});

    expect(screen.getByText('No image')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders positioned indicators over the image', () => {
    const { container } = renderImage({
      src: '/assets/images/plant.png',
      indicators: [{ id: 'ind-1', x: 0.3, y: 0.7, label: 'Tank A' }],
    });

    expect(screen.getByText('Tank A')).toBeInTheDocument();
    const indicator = container.querySelector('.hmi-image__indicator') as HTMLElement;
    expect(indicator.style.left).toBe('30%');
    expect(indicator.style.top).toBe('70%');
  });
});
