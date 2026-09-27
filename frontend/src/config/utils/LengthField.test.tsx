import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LengthField } from './LengthField';
import { CYCLE_UNITS } from './lengthValue';

afterEach(cleanup);

/** Controlled, the way a property row drives it. */
function renderField(initial: unknown) {
  const seen: unknown[] = [];
  function Fixture() {
    const [value, setValue] = useState<unknown>(initial);
    return (
      <LengthField
        value={value}
        onChange={(v) => {
          seen.push(v);
          setValue(v);
        }}
      />
    );
  }
  render(<Fixture />);
  return seen;
}

const unitButton = () => screen.getByRole('button', { name: /.+/ });

describe('LengthField unit cycle', () => {
  it('steps through the offered units and wraps around', () => {
    renderField('16px');

    for (const expected of ['%', 'rem', 'auto', 'px']) {
      fireEvent.click(unitButton());
      expect(unitButton()).toHaveTextContent(expected);
    }
  });

  it('keeps a stored unit the cycle does not name, and returns to it', () => {
    // A project storing `40vh` used to lose it on one accidental click: the
    // unknown unit read as "start over" and became `px` with no way back.
    renderField('40vh');
    expect(unitButton()).toHaveTextContent('vh');

    for (const expected of [...CYCLE_UNITS]) {
      fireEvent.click(unitButton());
      expect(unitButton()).toHaveTextContent(expected);
    }

    fireEvent.click(unitButton());
    expect(unitButton()).toHaveTextContent('vh');
  });

  it('forgets a displaced unit when a value arrives from outside', () => {
    // An undo, or another widget selected, replaces what the row was editing,
    // so the `vh` it was holding on to for the cycle goes with it.
    function Fixture({ external }: { external: string }) {
      const [value, setValue] = useState<unknown>(external);
      useEffect(() => setValue(external), [external]);
      return <LengthField value={value} onChange={setValue} />;
    }
    const { rerender } = render(<Fixture external="40vh" />);
    fireEvent.click(unitButton());
    expect(unitButton()).toHaveTextContent('px');

    rerender(<Fixture external="2rem" />);
    expect(unitButton()).toHaveTextContent('rem');

    for (const expected of ['auto', 'px', '%', 'rem']) {
      fireEvent.click(unitButton());
      expect(unitButton()).toHaveTextContent(expected);
    }
  });
});
