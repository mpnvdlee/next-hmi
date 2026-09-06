import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StretchSpacer from './index';

function renderSpacer(properties?: Record<string, unknown>, layout?: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <StretchSpacer properties={properties} layout={layout} />
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

  // A `flex` shorthand whose value is unchanged from the previous render does
  // not get reapplied by React, so a fix that only reorders the object
  // literal (widget's own sizing spread after the layout's) can still lose on
  // an *update* — a newly-appeared `flexGrow`/`flexBasis` from `layout` lands
  // as a distinct style key and wins regardless of source order within one
  // render. Exercising a real update (not just a fresh mount) is the point.
  it('keeps its own ratio after an update introduces a stored grow, not just on the first render', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <StretchSpacer properties={{ ratio: 3 }} />
      </MemoryRouter>,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.style.flexGrow).toBe('3');
    expect(el.style.flexBasis).toBe('0px');

    // As if this widget had a raw `grow` stored on its layout — the one
    // pre-size-mode field `selfLayoutStyle` still carries straight through —
    // which must not out-rank the widget's own Ratio on update.
    rerender(
      <MemoryRouter>
        <StretchSpacer properties={{ ratio: 3 }} layout={{ grow: 1 }} />
      </MemoryRouter>,
    );
    expect(el.style.flexGrow).toBe('3');
    expect(el.style.flexBasis).toBe('0px');
  });
});
