import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FixedSpacer from './index';

function renderSpacer(properties?: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <FixedSpacer properties={properties} />
    </MemoryRouter>,
  );
}

describe('FixedSpacer', () => {
  it('defaults to an 8px fixed flex-basis', () => {
    const { container } = renderSpacer();

    expect((container.firstChild as HTMLElement).style.flex).toBe('0 0 8px');
  });

  it('uses the configured size', () => {
    const { container } = renderSpacer({ size: 24 });

    expect((container.firstChild as HTMLElement).style.flex).toBe('0 0 24px');
  });

  it('clamps a negative size to 0', () => {
    const { container } = renderSpacer({ size: -10 });

    expect((container.firstChild as HTMLElement).style.flex).toBe('0 0 0px');
  });
});
