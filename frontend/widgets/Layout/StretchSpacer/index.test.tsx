import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StretchSpacer from './index';

function renderSpacer(properties?: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <StretchSpacer properties={properties} />
    </MemoryRouter>,
  );
}

describe('StretchSpacer', () => {
  it('defaults to a ratio of 1', () => {
    const { container } = renderSpacer();

    expect((container.firstChild as HTMLElement).style.flex).toBe('1 1 0px');
  });

  it('uses the configured ratio', () => {
    const { container } = renderSpacer({ ratio: 3 });

    expect((container.firstChild as HTMLElement).style.flex).toBe('3 1 0px');
  });

  it('switches to a percent basis in percent mode', () => {
    const { container } = renderSpacer({ mode: 'percent', percent: 40 });

    expect((container.firstChild as HTMLElement).style.flex).toBe('0 0 40%');
  });

  it('clamps a negative ratio to 0', () => {
    const { container } = renderSpacer({ ratio: -2 });

    expect((container.firstChild as HTMLElement).style.flex).toBe('0 1 0px');
  });
});
