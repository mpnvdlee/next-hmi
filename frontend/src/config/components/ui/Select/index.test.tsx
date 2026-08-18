import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Select from './index';

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the popup's active-option effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

function Fixture({
  value,
  onChange,
  disabled,
  popupClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  popupClassName?: string;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      disabled={disabled}
      popupClassName={popupClassName}
      aria-label="Fruit"
    >
      <option value="apple">Apple</option>
      <option value="banana" disabled>
        Banana
      </option>
      <option value="cherry">Cherry</option>
      <option value="date">Date</option>
    </Select>
  );
}

function trigger() {
  return screen.getByRole('combobox', { name: 'Fruit' });
}

describe('Select', () => {
  it('opens the listbox on click and closes it on a second click', () => {
    render(<Fixture value="apple" onChange={vi.fn()} />);
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open when disabled', () => {
    render(<Fixture value="apple" onChange={vi.fn()} disabled />);
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  describe('keyboard navigation', () => {
    it('opens on ArrowDown from a closed trigger', () => {
      render(<Fixture value="apple" onChange={vi.fn()} />);
      fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('moves the active option down and up, skipping disabled options', () => {
      render(<Fixture value="apple" onChange={vi.fn()} />);
      fireEvent.click(trigger());

      // Starts on the selected option (apple, index 0).
      expect(trigger()).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-0'));

      // ArrowDown moves to banana, but it's disabled, so it skips to cherry (index 2).
      fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
      expect(trigger()).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-2'));

      // ArrowUp moves back, skipping the disabled banana, landing on apple (index 0).
      fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
      expect(trigger()).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-0'));
    });

    it('Home/End jump to the first/last enabled option', () => {
      render(<Fixture value="apple" onChange={vi.fn()} />);
      fireEvent.click(trigger());

      fireEvent.keyDown(trigger(), { key: 'End' });
      expect(trigger()).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-3'));

      fireEvent.keyDown(trigger(), { key: 'Home' });
      expect(trigger()).toHaveAttribute('aria-activedescendant', expect.stringContaining('-opt-0'));
    });

    it('commits the active option and closes on Enter', () => {
      const onChange = vi.fn();
      render(<Fixture value="apple" onChange={onChange} />);
      fireEvent.click(trigger());
      fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); // -> cherry (skips disabled banana)
      fireEvent.keyDown(trigger(), { key: 'Enter' });

      expect(onChange).toHaveBeenCalledWith('cherry');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('never selects a disabled option via typeahead or click', () => {
      const onChange = vi.fn();
      render(<Fixture value="apple" onChange={onChange} />);
      fireEvent.click(trigger());

      fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
      expect(onChange).not.toHaveBeenCalled();
      // The picker stays open — a disabled option is not a valid choice.
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('closes on Escape and restores focus to the trigger', () => {
      render(<Fixture value="apple" onChange={vi.fn()} />);
      const btn = trigger();
      btn.focus();
      fireEvent.click(btn);
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.keyDown(btn, { key: 'Escape' });

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(btn);
    });

    it('closes without changing selection on Tab', () => {
      const onChange = vi.fn();
      render(<Fixture value="apple" onChange={onChange} />);
      fireEvent.click(trigger());
      fireEvent.keyDown(trigger(), { key: 'Tab' });

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('jumps to the option matching a typeahead buffer built from consecutive keystrokes', () => {
      vi.useFakeTimers();
      try {
        render(<Fixture value="apple" onChange={vi.fn()} />);
        fireEvent.click(trigger());

        fireEvent.keyDown(trigger(), { key: 'd' });
        expect(trigger()).toHaveAttribute(
          'aria-activedescendant',
          expect.stringContaining('-opt-3'),
        ); // Date

        // A fresh keystroke after the typeahead window resets the buffer.
        vi.advanceTimersByTime(700);
        fireEvent.keyDown(trigger(), { key: 'a' });
        expect(trigger()).toHaveAttribute(
          'aria-activedescendant',
          expect.stringContaining('-opt-0'),
        ); // Apple
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('confirms a click on an enabled option and moves focus back to the trigger', () => {
    const onChange = vi.fn();
    render(<Fixture value="apple" onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'Cherry' }));

    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes when a pointerdown lands outside the trigger and popup', () => {
    render(<Fixture value="apple" onChange={vi.fn()} />);
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  describe('popup width and placement', () => {
    /** Pins the trigger's box and the popup's rendered width, neither of which
     *  jsdom lays out on its own. */
    function stubLayout(triggerLeft: number, triggerWidth: number, popupWidth: number) {
      window.innerWidth = 1000;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: triggerLeft,
        right: triggerLeft + triggerWidth,
        width: triggerWidth,
        top: 100,
        bottom: 124,
        height: 24,
        x: triggerLeft,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect);
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(popupWidth);
    }

    afterEach(() => vi.restoreAllMocks());

    it('passes popupClassName to the portaled option list', () => {
      render(
        <Select value="apple" onChange={vi.fn()} popupClassName="wide-menu" aria-label="Fruit">
          <option value="apple">Apple</option>
        </Select>,
      );
      fireEvent.click(trigger());

      expect(screen.getByRole('listbox')).toHaveClass('cfg-select-popup', 'wide-menu');
    });

    it('keeps the trigger’s left edge while the popup fits', () => {
      stubLayout(200, 60, 60);
      render(<Fixture value="apple" onChange={vi.fn()} />);
      fireEvent.click(trigger());

      expect(screen.getByRole('listbox').style.left).toBe('200px');
    });

    it('slides a popup wider than its trigger back inside the right edge', () => {
      // A compact trigger docked right, with a stylesheet-widened menu: 940 +
      // 180 would run 120px past the window, so it right-aligns instead.
      stubLayout(940, 55, 180);
      render(<Fixture value="apple" onChange={vi.fn()} popupClassName="wide-menu" />);
      fireEvent.click(trigger());

      expect(screen.getByRole('listbox').style.left).toBe('812px');
    });

    it('never pushes the popup off the left edge on a very narrow window', () => {
      stubLayout(10, 55, 1200);
      render(<Fixture value="apple" onChange={vi.fn()} popupClassName="wide-menu" />);
      fireEvent.click(trigger());

      expect(screen.getByRole('listbox').style.left).toBe('8px');
    });

    it('clamps a plain Select against its trigger without measuring the popup', () => {
      // Only a popupClassName stylesheet can widen the popup past the trigger,
      // so the common path must not force a layout by reading offsetWidth —
      // reposition runs on every capture-phase scroll while the popup is open.
      stubLayout(960, 55, 55);
      const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
      render(<Fixture value="apple" onChange={vi.fn()} />);
      fireEvent.click(trigger());

      expect(offsetWidth).not.toHaveBeenCalled();
      expect(screen.getByRole('listbox').style.left).toBe('937px');
    });
  });

  it('shows the placeholder when no option matches the current value', () => {
    render(
      <Select value="missing" onChange={vi.fn()} placeholder="Pick one" aria-label="Fruit">
        <option value="apple">Apple</option>
      </Select>,
    );
    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });
});
