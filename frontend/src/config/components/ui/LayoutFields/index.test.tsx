import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { LayoutConfig } from '@shared/types/config';

import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { usePanelExpansionStore } from '@config/store/panelExpansionStore';

import { LayoutFields } from './index';

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the Select popup calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  // Section expand state is session-scoped and module-level, so a test that
  // opens a section would leave it open for the next one.
  usePanelExpansionStore.setState({ expanded: {} });
});

function setup(layout: Partial<LayoutConfig>) {
  const onChange = vi.fn();
  render(<LayoutFields mode="leaf" layout={layout} onChange={onChange} />);
  return onChange;
}

/** The Hug/Fill/Fixed button group for one axis's mode row. Scoped to that row
 *  so "Hug"/"Fill"/"Fixed" button queries don't collide between the Width and
 *  Height mode rows. */
function sizeModeGroup(axis: 'Width' | 'Height') {
  const label = screen.queryByText(`${axis} mode`, { selector: '.cfg-field-group__label' });
  return label ? within(label.closest('.cfg-field-group') as HTMLElement) : null;
}

describe('LayoutFields size mode', () => {
  // A mode means the same thing under any parent — `hmi.css` resolves it
  // against the real flow at render, off the flex parent's own
  // `data-flow-direction` — so the panel offers every row regardless. What it
  // no longer knows is which axis its parent will treat as main, so both get
  // the same neutral Hug default rather than one claiming a main-axis-flavoured
  // Hug and the other a cross-axis-flavoured Fill.
  it('gives each axis its own Hug/Fill/Fixed row, both defaulting to Hug', () => {
    setup({});

    expect(sizeModeGroup('Width')).not.toBeNull();
    expect(sizeModeGroup('Height')).not.toBeNull();
    for (const axis of ['Width', 'Height'] as const) {
      expect(sizeModeGroup(axis)!.getByRole('button', { name: 'Hug' })).toHaveClass(
        'cfg-seg-btn--default',
      );
      for (const name of ['Fill', 'Fixed']) {
        expect(sizeModeGroup(axis)!.getByRole('button', { name })).not.toHaveClass(
          'cfg-seg-btn--default',
        );
      }
    }
  });

  // A mode click writes the mode itself and nothing but the keys it retires (see
  // the cleanup test below) — `hmi.css`'s flow-translation block, not the
  // editor, is what turns it into flex-grow/basis/align-self at render.
  it('writes the mode key on a click, for either axis', () => {
    const onChange = setup({});
    fireEvent.click(sizeModeGroup('Height')!.getByRole('button', { name: 'Fill' }));
    expect(onChange).toHaveBeenCalledWith({ heightMode: 'fill' });

    cleanup();
    const onChange2 = setup({});
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Fill' }));
    expect(onChange2).toHaveBeenCalledWith({ widthMode: 'fill' });
  });

  // An axis's row below its mode is either a length editor or a dash naming
  // the mode that derived the length instead. It reads as the editor under
  // Fixed, and whenever the mode can't be read (unset, bound, mixed), since a
  // length is always the safer default to show editable.
  it('shows the length editor under Fixed or an unresolved mode', () => {
    setup({ width: '200px', widthMode: 'fixed' });
    expect(screen.getByDisplayValue(200)).toBeEnabled();

    cleanup();
    setup({ width: '150px' }); // widthMode unset — same as before this row existed
    expect(screen.getByDisplayValue(150)).toBeEnabled();

    cleanup();
    const bound = { widthMode: { $var: { path: 'MyPLC:Mode' } }, width: '80px' } as never;
    setup(bound);
    expect(screen.getByDisplayValue(80)).toBeEnabled();
  });

  // Fill derives the axis's length the same way Hug does, so it gets the same
  // read-only dash — only the mode named in it changes. The weight itself is
  // not an axis row at all any more; it sits below both (see the placement
  // test further down).
  it('shows a derived dash under Fill, with the weight as its own row', () => {
    // Height pinned to a definite Fixed so its own axis can't also hedge a
    // dash into the query — see the dedicated hedge tests above for the
    // genuinely-unset case.
    setup({ widthMode: 'fill', grow: 2, heightMode: 'fixed', height: '50px' });
    expect(screen.getByLabelText('Width (set by Fill)')).toBeDisabled();
    expect(screen.getByText('Fill weight')).toBeInTheDocument();
    expect(screen.getByDisplayValue(2)).toBeEnabled();

    cleanup();
    setup({ widthMode: 'hug', heightMode: 'fixed', height: '50px' });
    expect(screen.getByText('Width')).toBeInTheDocument();
    expect(screen.getByLabelText('Width (set by Hug)')).toBeDisabled();
  });

  // Like the length row, the Fill weight is a plain `renderRow` field once
  // Fill is picked — it gets the standard source pill, not a bespoke input.
  it('offers a variable picker on the Fill weight row too', () => {
    render(
      <LayoutFields
        mode="leaf"
        layout={{ widthMode: 'fill', heightMode: 'fixed', height: '50px' }}
        onChange={vi.fn()}
        componentId="w1"
      />,
    );

    const label = screen.getByText('Fill weight', { selector: '.cfg-field-group__label' });
    const row = label.closest('.cfg-field-group') as HTMLElement;
    expect(within(row).getByLabelText('Static Value')).toBeInTheDocument();
  });

  // Either axis on Fill is enough to surface the weight, since the panel has
  // no way to know which axis the runtime will read `grow` back through. The
  // axis itself gets the derived dash either way — Hug and Fill differ only in
  // the mode the dash names. Width pinned to Fixed so its own row stays out of
  // the way of what this test is checking.
  it('names the mode that derived an axis length, Fill as well as Hug', () => {
    setup({ widthMode: 'fixed', heightMode: 'fill', height: '80px' });
    expect(screen.getByLabelText('Height (set by Fill)')).toBeDisabled();
    expect(screen.queryByDisplayValue(80)).not.toBeInTheDocument();
    expect(screen.getByText('Fill weight')).toBeInTheDocument();

    cleanup();
    setup({ widthMode: 'fixed', heightMode: 'hug', height: '80px' });
    expect(screen.getByLabelText('Height (set by Hug)')).toBeDisabled();
  });

  // Unlike the panel's old main/cross split, an *unresolved* mode — including
  // genuinely unset — reaches the weight the same way a literal Fill does: the
  // panel can no longer rule an axis out as "definitely not the one that ends
  // up main", so a still-unset Height keeps the weight reachable on its own.
  it('shows the weight row for an unresolved mode on either axis, not only a literal Fill', () => {
    setup({ widthMode: 'fixed', width: '200px' }); // heightMode left unset

    expect(screen.getAllByText('Fill weight')).toHaveLength(1);
  });

  // The regression this row's rework exists for: `grow` is one stored number,
  // so it gets one row. Both axes on Fill used to render it twice — same label,
  // same value, same key — which read as two independent per-axis weights.
  it('shows exactly one Fill weight row when both axes are Fill', () => {
    const onChange = setup({ widthMode: 'fill', heightMode: 'fill', grow: 2 });
    const weightRows = screen.getAllByText('Fill weight', {
      selector: '.cfg-field-group__label',
    });
    expect(weightRows).toHaveLength(1);

    const input = (weightRows[0].closest('.cfg-field-group') as HTMLElement).querySelector(
      'input',
    )!;
    expect(input).toHaveValue(2);

    fireEvent.change(input, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith({ grow: 5 });
  });

  // It is a node-level value rather than an axis one, so it sits below both
  // axis blocks instead of inside whichever of them happens to be Fill.
  it('places the Fill weight row below both axis blocks', () => {
    setup({ widthMode: 'fill', heightMode: 'fill', grow: 2 });
    const weight = screen.getByText('Fill weight', { selector: '.cfg-field-group__label' });
    const maxHeight = screen.getByText('Max height', { selector: '.cfg-field-group__label' });

    expect(
      maxHeight.compareDocumentPosition(weight) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The mirror of the hedge tests: once both axes are definite non-Fill, no
  // axis reaches the weight and the row goes entirely — matching the pick that
  // clears the stored key.
  it('shows no Fill weight row once neither axis reaches it', () => {
    setup({ widthMode: 'fixed', width: '200px', heightMode: 'hug' });

    expect(screen.queryByText('Fill weight')).not.toBeInTheDocument();
  });

  // Every mode row is its axis's only writer, so it owns the cleanup: a key the
  // pick puts out of reach is a key the project would otherwise store with no
  // row to show, revert or explain it.
  it('clears the keys a mode pick puts out of reach', () => {
    // Fill reads `grow`, so the length goes.
    const onFill = setup({ width: '200px', widthMode: 'fixed' });
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Fill' }));
    expect(onFill).toHaveBeenCalledWith({ widthMode: 'fill', width: undefined });

    // ...and back the other way: a definite non-Fill on the other axis means
    // no row anywhere could still show, revert or explain the weight, so it
    // must go too.
    cleanup();
    const onFixed = setup({ widthMode: 'fill', grow: 2, heightMode: 'hug' });
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Fixed' }));
    expect(onFixed).toHaveBeenCalledWith({ widthMode: 'fixed', grow: undefined });

    // Hug reads neither, same story when the other axis is a definite non-Fill.
    cleanup();
    const onHug = setup({ width: '200px', grow: 2, widthMode: 'fill', heightMode: 'fixed' });
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Hug' }));
    expect(onHug).toHaveBeenCalledWith({ widthMode: 'hug', width: undefined, grow: undefined });

    // The other axis never owned the weight, so a pick that puts it out of
    // this axis's own reach leaves it alone — as long as the axis this pick
    // didn't touch is still a literal Fill, still reading it.
    cleanup();
    const onOther = setup({ height: '80px', grow: 2, widthMode: 'fill' });
    fireEvent.click(sizeModeGroup('Height')!.getByRole('button', { name: 'Hug' }));
    expect(onOther).toHaveBeenCalledWith({ heightMode: 'hug', height: undefined });
    expect(onOther.mock.calls[0][0]).not.toHaveProperty('grow');
  });

  // A weight set from Height, while Width is Fixed, is not Width's own pick to
  // clear — but once Height itself moves off Fill, no row is left that could
  // show, revert or explain the weight, so it must go too, or the project
  // would keep a `grow` no panel state can ever surface again.
  it('clears grow from a pick once no axis is left reaching it', () => {
    const onChange = setup({ widthMode: 'fixed', heightMode: 'fill', grow: 3 });
    fireEvent.click(sizeModeGroup('Height')!.getByRole('button', { name: 'Hug' }));
    expect(onChange).toHaveBeenCalledWith({
      heightMode: 'hug',
      height: undefined,
      grow: undefined,
    });
  });

  // Width's own mode is left unset, which `reachableSizeKeys` hedges as "still
  // might resolve to Fill" — the panel can no longer tell whether it will end
  // up the axis its parent treats as main. A pick on Height away from Fill
  // must not gamble that hedge away.
  it('keeps grow from a pick away from Fill while the other axis is left unset', () => {
    const onChange = setup({ heightMode: 'fill', grow: 3 });
    fireEvent.click(sizeModeGroup('Height')!.getByRole('button', { name: 'Hug' }));
    expect(onChange).toHaveBeenCalledWith({ heightMode: 'hug', height: undefined });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('grow');
  });

  // A pick away from Fill on one axis must not clear a weight the other
  // axis's own literal Fill still reads — its row is still showing it.
  it('keeps grow on a Hug pick when the other axis is a literal Fill', () => {
    const onChange = setup({ widthMode: 'fill', heightMode: 'fill', grow: 2 });
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Hug' }));
    expect(onChange).toHaveBeenCalledWith({ widthMode: 'hug', width: undefined });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('grow');
  });

  // The other axis's mode may be present but unreadable here — `$var`-bound,
  // or disagreeing across a multi-selection — and may still resolve to Fill
  // once it does, same as its own unreadable mode is never ruled out
  // (`sizeValueRows`). A pick away from Fill must not gamble on that and clear
  // the weight out from under it.
  it('keeps grow on a Hug pick when the other axis is mixed or bound rather than genuinely unset', () => {
    const onChange = vi.fn();
    const mixedLayout = new Map([['heightMode', null]]) as never;
    render(
      <LayoutFields
        mode="leaf"
        layout={{ widthMode: 'fill', grow: 2 }}
        onChange={onChange}
        mixedLayout={mixedLayout}
      />,
    );
    fireEvent.click(sizeModeGroup('Width')!.getByRole('button', { name: 'Hug' }));
    expect(onChange).toHaveBeenCalledWith({ widthMode: 'hug', width: undefined });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('grow');
  });

  // Neither key can be ruled out while the mode is unreadable, and a weight with
  // no row is a weight the author cannot revert — so both rows show, and
  // `sizeModePatch` clears neither.
  it('offers the length and the grow weight together under an unreadable mode', () => {
    // Height pinned to Fixed so its own row can't also hedge a duplicate
    // "grow" display value into the query.
    const bound = {
      widthMode: { $var: { path: 'MyPLC:Mode' } },
      width: '80px',
      grow: 2,
      heightMode: 'fixed',
      height: '50px',
    } as never;
    const onChange = setup(bound);

    expect(screen.getByDisplayValue(80)).toBeEnabled();
    expect(screen.getByDisplayValue(2)).toBeEnabled();

    cleanup();
    // An unset mode reads from both too, same hedge as an unreadable one.
    setup({ width: '150px', grow: 2, heightMode: 'fixed', height: '50px' });
    expect(screen.getByDisplayValue(150)).toBeEnabled();
    expect(screen.getByDisplayValue(2)).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  // The editor never needs a parent flow to decide whether to show the mode
  // row — it always does — so a `$var`-bound mode still gets its row.
  it('still offers the mode row when the mode itself is a $var', () => {
    setup({ widthMode: { $var: { path: 'MyPLC:Mode' } } } as never);

    expect(sizeModeGroup('Width')).not.toBeNull();
  });
});

describe('LayoutFields padding', () => {
  /** One padding side's row, scoped by its own label — the four are separate
   *  rows now, so every query has to say which side it means. */
  function sideRow(side: 'top' | 'right' | 'bottom' | 'left') {
    const label = screen.getByText(`Padding ${side}`, { selector: '.cfg-field-group__label' });
    return within(label.closest('.cfg-field-group') as HTMLElement);
  }

  const SIDES = ['top', 'right', 'bottom', 'left'] as const;

  // Four independent keys, four independent rows — no merged "all sides"
  // control on top of them, so nothing has to decide when the four agree
  // closely enough to collapse into one.
  it('gives every side its own row and no merged one', () => {
    render(<LayoutFields mode="container" layout={{}} onChange={vi.fn()} />);

    for (const side of SIDES) expect(sideRow(side)).toBeTruthy();
    expect(
      screen.queryByText('Padding', { selector: '.cfg-field-group__label' }),
    ).not.toBeInTheDocument();
  });

  it('reads each side from its own key', () => {
    render(
      <LayoutFields
        mode="container"
        layout={{ paddingTop: '8px', paddingRight: '4px', paddingBottom: '4px' }}
        onChange={vi.fn()}
      />,
    );

    expect(sideRow('top').getByRole('spinbutton')).toHaveValue(8);
    expect(sideRow('right').getByRole('spinbutton')).toHaveValue(4);
    expect(sideRow('bottom').getByRole('spinbutton')).toHaveValue(4);
    expect(sideRow('left').getByRole('spinbutton')).toHaveValue(null);
  });

  it('writes only the side the edited row owns', () => {
    const onChange = vi.fn();
    render(
      <LayoutFields
        mode="container"
        layout={{ paddingTop: '8px', paddingRight: '8px' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(sideRow('right').getByRole('spinbutton'), { target: { value: '20' } });

    expect(onChange).toHaveBeenCalledWith({ paddingRight: '20px' });
  });

  // Plain `SchemaFieldRow`s, so a `$`-sourced side keeps its own row and its own
  // source pill — there is no literal-only box left for a binding to fall out
  // of, and the other three sides are untouched by it.
  it('leaves a bound side bound, and its siblings alone', () => {
    const bound = { $var: { path: 'MyPLC:V' } } as never;
    render(
      <LayoutFields mode="container" layout={{ paddingTop: bound, paddingLeft: '4px' }} onChange={vi.fn()} />,
    );

    for (const side of SIDES) expect(sideRow(side)).toBeTruthy();
    expect(sideRow('top').queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(sideRow('left').getByRole('spinbutton')).toHaveValue(4);
  });

  it("shows Mixed on the disagreeing side only, not the lead widget's value", () => {
    const mixedLayout = new Map([['paddingRight', 'static']]) as never;
    render(
      <LayoutFields
        mode="container"
        layout={{ paddingTop: '8px', paddingRight: '8px' }}
        onChange={vi.fn()}
        mixedLayout={mixedLayout}
      />,
    );

    expect(sideRow('right').getByPlaceholderText('Mixed')).toBeInTheDocument();
    expect(sideRow('top').queryByPlaceholderText('Mixed')).not.toBeInTheDocument();
  });

  // The bespoke pencil button the merged box needed is gone with it: every side
  // is a `SchemaFieldRow` now, so binding goes through the standard source pill
  // and lands on that side's own layout key rather than on a stand-in for all
  // four.
  it('binds one side at a time, against that side\'s own key', () => {
    const onChange = vi.fn();
    const bound = { $var: { path: 'MyPLC:Pad' } } as never;
    render(
      <LayoutFields
        mode="container"
        layout={{ paddingBottom: bound }}
        onChange={onChange}
        componentId="w1"
      />,
    );

    expect(screen.queryByTitle('Bind padding to a variable')).not.toBeInTheDocument();
    fireEvent.click(sideRow('bottom').getByTitle('Change variable binding'));

    const { bindingPickerOpen, bindingPickerTarget } = useEditorDomainStore.getState();
    expect(bindingPickerOpen).toBe(true);
    expect(bindingPickerTarget).toMatchObject({
      componentId: 'w1',
      propertyKey: '__layout__.paddingBottom',
    });

    bindingPickerTarget?.onPick?.({ path: 'MyPLC:Other' });
    expect(onChange).toHaveBeenCalledWith({ paddingBottom: { $var: { path: 'MyPLC:Other' } } });
  });
});

describe('LayoutFields align and distribute', () => {
  const alignButton = (name: string) => screen.getByRole('button', { name });

  it('names each option for the axis the container actually lays out on', () => {
    render(<LayoutFields mode="container" layout={{}} onChange={vi.fn()} />);

    // Row container: `align` is the vertical axis, `justify` the horizontal one.
    for (const name of ['Top', 'Middle', 'Bottom', 'Stretch', 'Left', 'Center', 'Right']) {
      expect(alignButton(name)).toBeInTheDocument();
    }

    cleanup();
    render(<LayoutFields mode="container" layout={{ direction: 'column' }} onChange={vi.fn()} />);

    // Column container: the two swap, so every position name still says where
    // the children end up on screen.
    expect(alignButton('Left')).toBeInTheDocument();
    expect(alignButton('Space between')).toBeInTheDocument();
  });

  it('writes the CSS value the option stands for', () => {
    const onChange = vi.fn();
    render(<LayoutFields mode="container" layout={{}} onChange={onChange} />);

    fireEvent.click(alignButton('Middle'));
    expect(onChange).toHaveBeenCalledWith({ align: 'center' });

    fireEvent.click(alignButton('Space between'));
    expect(onChange).toHaveBeenCalledWith({ justify: 'space-between' });
  });

  // `stretch` is the `align-items` default and what a child's cross-axis Fill
  // rides on, so an unset row has to show it as in effect rather than blank.
  it('marks the default option while unset, and offers the revert once set', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LayoutFields mode="container" layout={{}} onChange={onChange} />);

    expect(alignButton('Stretch')).toHaveClass('cfg-seg-btn--default');
    expect(screen.queryByTitle(/^Revert to default/)).not.toBeInTheDocument();

    rerender(<LayoutFields mode="container" layout={{ align: 'center' }} onChange={onChange} />);
    fireEvent.click(screen.getByTitle(/^Revert to default/));

    expect(onChange).toHaveBeenCalledWith({ align: undefined });
  });
});

describe('LayoutFields direction', () => {
  it('renders the icon group, keeping each option named for screen readers', () => {
    render(<LayoutFields mode="container" layout={{}} onChange={vi.fn()} />);

    const row = screen.getByRole('button', { name: 'Row' });
    expect(row).toHaveAttribute('title', 'Row');
    expect(row.querySelector('.cfg-seg-btn__icon')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Column' })).toBeInTheDocument();
  });

  // Wrap folds into Figma's direction control as a third state; ours keeps it
  // separate so `column` + `wrap` stays expressible.
  it('leaves Wrap as its own field rather than folding it in', () => {
    render(<LayoutFields mode="container" layout={{}} onChange={vi.fn()} />);

    // "Wrap" is also one of the boolean group's own button labels, so match the row.
    expect(screen.getByText('Wrap', { selector: '.cfg-field-group__label' })).toBeInTheDocument();
  });
});

describe('LayoutFields margin', () => {
  // Gone from the panel and from `LayoutConfig` both. A margin left in an
  // unmigrated project reaches here as an unknown key and must not draw a row.
  it('offers no margin rows', () => {
    const stored = { margin: '8px' } as Partial<LayoutConfig>;
    render(<LayoutFields mode="container" layout={stored} onChange={vi.fn()} />);

    for (const label of ['Margin', 'Margin top', 'Margin right', 'Margin bottom', 'Margin left']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
});

describe('LayoutFields — one flat list', () => {
  // Every row the panel has is on screen from the start. The bounds used to sit
  // behind an "Advanced" disclosure, which is exactly how a max-width you set
  // once and forgot goes on quietly winning an argument you can't see.
  it('shows the bounds without anything to open first', () => {
    setup({});

    for (const label of ['Min width', 'Max width', 'Min height', 'Max height']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
  });

  // The panel offers what a design tool offers and nothing more: the raw flex
  // four have no row anywhere. Hug/Fill/Fixed and the container's own Align say
  // everything they used to say.
  it('offers no row for the raw flex properties at all', () => {
    setup({});

    for (const label of ['Basis', 'Grow', 'Shrink', 'Align self']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(sizeModeGroup('Width')).not.toBeNull();
  });
});
