import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FixedSpacer from './index';

function renderSpacer(properties?: Record<string, unknown>, layout?: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <FixedSpacer properties={properties} layout={layout} />
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

  // See StretchSpacer's equivalent test: a `flex` shorthand whose value is
  // unchanged from the previous render is not reapplied by React, so this has
  // to exercise a real update, not just a fresh mount.
  it('keeps its own fixed size after an update introduces a stored grow, not just on the first render', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <FixedSpacer properties={{ size: 24 }} />
      </MemoryRouter>,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.style.flexGrow).toBe('0');
    expect(el.style.flexBasis).toBe('24px');

    // As if the Layout panel had just switched this widget's Width to Fill.
    rerender(
      <MemoryRouter>
        <FixedSpacer properties={{ size: 24 }} layout={{ grow: 1 }} />
      </MemoryRouter>,
    );
    expect(el.style.flexGrow).toBe('0');
    expect(el.style.flexBasis).toBe('24px');
  });
});
