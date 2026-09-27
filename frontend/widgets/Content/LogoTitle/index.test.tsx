import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogoTitle from './index';

function renderLogoTitle(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <LogoTitle properties={properties} />
    </MemoryRouter>,
  );
}

describe('LogoTitle', () => {
  it('renders without throwing on empty properties', () => {
    renderLogoTitle({});
    expect(screen.getByText('NEXT HMI')).toBeInTheDocument();
  });

  it('carries the base component class alongside its own', () => {
    const { container } = renderLogoTitle({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.classList.contains('hmi-component')).toBe(true);
    expect(el.classList.contains('hmi-logo-title')).toBe(true);
  });

  it('renders the title, the subtitle and the logo image', () => {
    const { container } = renderLogoTitle({
      title: 'Aquavane',
      subtitle: 'Line 4',
      logoUrl: '/assets/logo.svg',
    });

    expect(screen.getByText('Aquavane')).toBeInTheDocument();
    expect(screen.getByText('Line 4')).toBeInTheDocument();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/logo.svg');
  });

  it('roots a bound logo path under /assets, the way a $static payload arrives', () => {
    // A $var or $urlParam on the asset field delivers the stored path verbatim;
    // in `src` a project-relative one would resolve against the page url.
    const { container } = renderLogoTitle({ logoUrl: 'images/logo.svg' });

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/images/logo.svg');
  });

  it('leaves an already-resolved logo url alone', () => {
    const { container } = renderLogoTitle({ logoUrl: { $static: { path: 'images/logo.svg' } } });

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/images/logo.svg');
  });

  it('omits the image and the subtitle when neither is configured', () => {
    const { container } = renderLogoTitle({ title: 'Aquavane' });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.hmi-logo-title__subtitle')).toBeNull();
  });

  it('resolves the title through a property source', () => {
    renderLogoTitle({ title: { $static: 'From a source' } });
    expect(screen.getByText('From a source')).toBeInTheDocument();
  });
});
