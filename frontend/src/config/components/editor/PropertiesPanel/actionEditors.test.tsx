import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonAction, PageConfig, PageNode } from '@shared/types/config';
import type ActionsInputType from './ActionsInput';
import { ACTION_EDITORS, editorTargetAddress, type ActionEditorCtx } from './actionEditors';
import {
  RepeatEditorScopeContext,
  type RepeatEditorScope,
} from '../PropertySourceEditor/repeatScopeContext';

// jsdom doesn't implement scrollIntoView; Select's popup calls it to keep the
// active option in view once opened.
Element.prototype.scrollIntoView = vi.fn();

// Regression test for the `Select` component's `parseOptions()` only discovering
// raw <option>/<optgroup> children — passing the placement list through a JSX
// component (`<PlacementOptions />`) made the option list resolve to empty,
// leaving the Placement dropdown blank and unselectable in the running editor.

function makeCtx(): ActionEditorCtx {
  return {
    update: vi.fn(),
    overlayTargets: { dialogs: [], pages: [] },
    dataTypes: {},
    openBindingPicker: vi.fn(),
    openWriteVarPicker: vi.fn(),
    ActionsInput: (() => null) as unknown as typeof ActionsInputType,
    path: ['actions', 'onPress', '0'],
  };
}

const EXPECTED_PLACEMENT_LABELS = [
  'Center',
  'Top',
  'Bottom',
  'Left',
  'Right',
  'Above trigger',
  'Below trigger',
  'Left of trigger',
  'Right of trigger',
];

// Tier-1 fields are always inline (no disclosure to expand) — scope to the
// Placement field's own group since the target picker, Size and Placement are
// all rendered as comboboxes simultaneously.
async function openPlacementSelect() {
  const user = userEvent.setup();
  const fieldGroup = screen.getByText('Placement').closest('.cfg-field-group') as HTMLElement;
  await user.click(within(fieldGroup).getByRole('combobox'));
}

describe('Placement select', () => {
  it('lists every placement option for the openPageOverlay action', async () => {
    const action: Extract<ButtonAction, { type: 'openPageOverlay' }> = {
      type: 'openPageOverlay',
      pageId: '',
    };
    const OpenPageOverlayEditor = ACTION_EDITORS.openPageOverlay!;
    render(<OpenPageOverlayEditor action={action} ctx={makeCtx()} />);

    await openPlacementSelect();

    for (const label of EXPECTED_PLACEMENT_LABELS) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });
});

describe('openDialog input parameters', () => {
  function pageWithParams(): PageConfig {
    return {
      id: 'p1',
      title: 'Motor detail',
      type: 'page',
      sections: { content: [] },
      componentProperties: { motorId: { type: 'String', label: 'Motor id' } },
    };
  }

  it('renders a row per property the target dialog declares', () => {
    const action: Extract<ButtonAction, { type: 'openDialog' }> = {
      type: 'openDialog',
      pageId: 'p1',
    };
    const ctx = { ...makeCtx(), overlayTargets: { dialogs: [pageWithParams()], pages: [] } };
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    render(<OpenDialogEditor action={action} ctx={ctx} />);

    expect(screen.getByText('Input Parameters')).toBeInTheDocument();
    expect(screen.getByText('Motor id')).toBeInTheDocument();
  });

  it('renders no section when the Dialogs-folder target declares nothing', () => {
    const action: Extract<ButtonAction, { type: 'openDialog' }> = {
      type: 'openDialog',
      pageId: 'p1',
    };
    const ctx = {
      ...makeCtx(),
      overlayTargets: {
        dialogs: [
          { id: 'p1', title: 'Plain', type: 'page', sections: { content: [] } } as PageConfig,
        ],
        pages: [],
      },
    };
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    render(<OpenDialogEditor action={action} ctx={ctx} />);

    expect(screen.queryByText('Input Parameters')).not.toBeInTheDocument();
  });

  it('renders no section for a target outside the Dialogs folder, even when it declares properties', () => {
    // componentProperties is only read for a node in the Dialogs folder — an
    // ordinary page never takes input parameters, however it's authored. The
    // backend flags the wrong-root target separately.
    const action: Extract<ButtonAction, { type: 'openDialog' }> = {
      type: 'openDialog',
      pageId: 'p1',
    };
    const ctx = { ...makeCtx(), overlayTargets: { dialogs: [], pages: [pageWithParams()] } };
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    render(<OpenDialogEditor action={action} ctx={ctx} />);

    expect(screen.queryByText('Input Parameters')).not.toBeInTheDocument();
  });

  it('offers page groups as dialog targets and reads their declarations', () => {
    // Open Dialog may name a group; the picker has to say which entries are
    // groups, since opening one is not the same as opening its first tab.
    const group = {
      id: 'g1',
      title: 'Machines',
      type: 'page-group',
      children: [],
      componentProperties: { lineId: { type: 'String', label: 'Line id' } },
    } as unknown as PageNode;
    const action: Extract<ButtonAction, { type: 'openDialog' }> = {
      type: 'openDialog',
      pageId: 'g1',
    };
    const ctx = {
      ...makeCtx(),
      overlayTargets: { dialogs: [pageWithParams(), group], pages: [] },
    };
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    const { container } = render(<OpenDialogEditor action={action} ctx={ctx} />);

    // The Dialog select resolved the group, and marks it as one.
    expect(container.textContent).toContain('Machines (page group)');
    expect(screen.getByText('Line id')).toBeInTheDocument();
  });
});

describe('overlay target pickers offer one root each', () => {
  const dialog = {
    id: 'd1',
    title: 'Confirm',
    type: 'page',
    sections: { content: [] },
  } as PageConfig;
  const page = {
    id: 'p1',
    title: 'Machine',
    type: 'page',
    sections: { content: [] },
  } as PageConfig;
  const targets = { dialogs: [dialog], pages: [page] };

  /** The custom `Select` portals its listbox, so the options only exist once
   *  the field named `label` is opened. */
  async function openTargetSelect(label: string) {
    const user = userEvent.setup();
    const fieldGroup = screen.getByText(label).closest('.cfg-field-group') as HTMLElement;
    await user.click(within(fieldGroup).getByRole('combobox'));
  }

  it('Open Dialog lists the Dialogs folder only', async () => {
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    render(
      <OpenDialogEditor
        action={{ type: 'openDialog', pageId: '' }}
        ctx={{ ...makeCtx(), overlayTargets: targets }}
      />,
    );

    await openTargetSelect('Dialog');

    expect(screen.getByRole('option', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Machine' })).not.toBeInTheDocument();
  });

  it('Open Page As Overlay lists the navigable pages only, and takes no input parameters', async () => {
    const OpenPageOverlayEditor = ACTION_EDITORS.openPageOverlay!;
    render(
      <OpenPageOverlayEditor
        action={{ type: 'openPageOverlay', pageId: '' }}
        ctx={{ ...makeCtx(), overlayTargets: targets }}
      />,
    );

    expect(screen.queryByText('Input Parameters')).not.toBeInTheDocument();
    await openTargetSelect('Page');

    expect(screen.getByRole('option', { name: 'Machine' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('Close Dialog/Overlay still spans both roots', async () => {
    const ClosePageOverlayEditor = ACTION_EDITORS.closePageOverlay!;
    render(
      <ClosePageOverlayEditor
        action={{ type: 'closePageOverlay' }}
        ctx={{ ...makeCtx(), overlayTargets: targets }}
      />,
    );

    await openTargetSelect('Page');

    expect(screen.getByRole('option', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Machine' })).toBeInTheDocument();
  });
});

describe('writeDataVariable coercion editor', () => {
  it('keeps UInt64 values as strings beyond the JavaScript safe integer range', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Counter' } },
      value: '18446744073709551615',
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Counter'] = { dataType: 'UInt64', isArray: false };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    const input = screen.getByPlaceholderText('Value');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('18446744073709551615');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('represents arrays as JSON and surfaces the stable matrix reason', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Steps' } },
      value: [1],
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Steps'] = { dataType: 'Int16', isArray: true, arrayLength: 2 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.getByPlaceholderText('JSON array')).toHaveValue('[1]');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The array has the wrong number of elements.',
    );
  });

  it('predicts backend rejection of a literal outside the configured min/max', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Temp' } },
      value: 11,
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Temp'] = { dataType: 'Float', isArray: false, min: -20, max: 10 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "The value is outside the variable's configured range.",
    );
  });

  it('accepts a literal within the configured min/max', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Temp' } },
      value: 5,
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Temp'] = { dataType: 'Float', isArray: false, min: -20, max: 10 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('write target inside a Repeater', () => {
  const SCALAR = { members: [], writable: true, elementType: 'Float' };
  const STRUCT = {
    members: ['Name', 'Speed'],
    writable: true,
    elementType: 'struct',
    memberTypes: { Name: 'String', Speed: 'Float' },
  };

  function renderWrite(
    scope: RepeatEditorScope | null,
    action: Partial<Extract<ButtonAction, { type: 'writeDataVariable' }>>,
    ctx = makeCtx(),
  ) {
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(
      <RepeatEditorScopeContext.Provider value={scope}>
        <Editor action={{ type: 'writeDataVariable', value: 0, ...action }} ctx={ctx} />
      </RepeatEditorScopeContext.Provider>,
    );
    return ctx;
  }

  function variableRow(): HTMLElement {
    return screen.getByText('Variable').closest('.cfg-field-group') as HTMLElement;
  }

  it("writes the copy's own element without asking which one", () => {
    renderWrite(SCALAR, { target: { $repeatItem: {} } });
    const row = within(variableRow());
    expect(row.getByText('Repeat item › Element (this copy)')).toBeInTheDocument();
    expect(row.queryByTitle('Choose the member to write')).not.toBeInTheDocument();
  });

  it('asks only which member of a struct element to write, in the Repeat item picker', async () => {
    const ctx = renderWrite(STRUCT, { target: { $repeatItem: {} } });
    await userEvent.setup().click(within(variableRow()).getByTitle('Choose the member to write'));
    const options = vi.mocked(ctx.openBindingPicker).mock.calls[0][2];
    expect(options?.repeatItem).toMatchObject({ writeTarget: true, scope: STRUCT });
    expect(vi.mocked(ctx.openWriteVarPicker)).not.toHaveBeenCalled();
  });

  it('opens the datasource picker, with no Repeat item in it, for a variable target', async () => {
    const ctx = renderWrite(SCALAR, {});
    await userEvent.setup().click(within(variableRow()).getByTitle('Change variable binding'));
    expect(vi.mocked(ctx.openWriteVarPicker)).toHaveBeenCalledWith();
    expect(vi.mocked(ctx.openBindingPicker)).not.toHaveBeenCalled();
  });

  it("types the value by the member it writes and reads it from the Repeat item's own picker", async () => {
    const ctx = renderWrite(STRUCT, {
      target: { $repeatItem: { member: 'Speed' } },
      value: { $repeatItem: { field: 'value', member: 'Speed' } },
    });
    const valueRow = screen.getByText('Value').closest('.cfg-field-group') as HTMLElement;
    await userEvent.setup().click(within(valueRow).getByTitle('Change binding'));
    const options = vi.mocked(ctx.openBindingPicker).mock.calls[0][2];
    expect(options?.filter).toEqual({ label: 'Value', type: 'Float' });
    expect(options?.repeatItem?.current).toEqual({ field: 'value', member: 'Speed' });
  });
});

describe('array index on a write target', () => {
  const indexRow = () =>
    screen.getByText(/^Element of the array/).closest('.cfg-field-group') as HTMLElement;

  it('asks a toggle on a whole array for its element in a row below Variable', () => {
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Open'] = { dataType: 'Boolean', isArray: true };
    const Editor = ACTION_EDITORS.toggleDataVariable!;
    render(
      <Editor
        action={{ type: 'toggleDataVariable', target: { $var: { path: 'PLC:Open' } } }}
        ctx={ctx}
      />,
    );
    const variableGroup = screen.getByText('Variable').closest('.cfg-field-group') as HTMLElement;
    // Part of the Variable field, under its box rather than inside it.
    expect(variableGroup.contains(indexRow())).toBe(true);
    expect(variableGroup.querySelector('.cfg-field-group__box')!.contains(indexRow())).toBe(false);
    fireEvent.change(within(indexRow()).getByPlaceholderText('Choose an element'), {
      target: { value: '3' },
    });
    expect(ctx.update).toHaveBeenCalledWith({
      target: { $var: { path: 'PLC:Open', index: { $static: 3 } } },
    });
  });

  it('offers a write the whole array, and resets the value when the row names an element', () => {
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Steps'] = { dataType: 'Int16', isArray: true };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(
      <Editor
        action={{
          type: 'writeDataVariable',
          target: { $var: { path: 'PLC:Steps' } },
          value: [1, 2],
        }}
        ctx={ctx}
      />,
    );
    fireEvent.change(within(indexRow()).getByPlaceholderText('Whole array'), {
      target: { value: '0' },
    });
    expect(ctx.update).toHaveBeenCalledWith({
      target: { $var: { path: 'PLC:Steps', index: { $static: 0 } } },
      value: 0,
    });
  });

  it('names a fixed $static index by its number and any other source as […]', () => {
    expect(editorTargetAddress({ $var: { path: 'PLC:Open', index: { $static: 3 } } })).toEqual({
      datasource: 'PLC',
      path: 'Open[3]',
    });
    expect(
      editorTargetAddress({ $var: { path: 'PLC:Open', index: { $componentProp: 'device' } } }),
    ).toEqual({ datasource: 'PLC', path: 'Open[…]' });
  });

  it.each([
    ['a variable that is no array', 'PLC:Run', { dataType: 'Boolean', isArray: false }],
    [
      'an element picked in the picker',
      'PLC:Open[3]',
      { dataType: 'Boolean', isArray: true, indexed: true },
    ],
  ])('adds no Index row for %s', (_, path, descriptor) => {
    const ctx = makeCtx();
    ctx.dataTypes[path] = descriptor;
    const Editor = ACTION_EDITORS.toggleDataVariable!;
    render(
      <Editor action={{ type: 'toggleDataVariable', target: { $var: { path } } }} ctx={ctx} />,
    );
    expect(screen.queryByText(/^Element of the array/)).not.toBeInTheDocument();
  });

  it('shows a bound index in its row, writes one element, and clearing it writes the whole array', () => {
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Steps[4]'] = { dataType: 'Int16', isArray: true, indexed: true };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(
      <Editor
        action={{
          type: 'writeDataVariable',
          target: { $var: { path: 'PLC:Steps', index: { $static: 4 } } },
          value: 5,
        }}
        ctx={ctx}
      />,
    );
    expect(screen.getByText('PLC:Steps')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('JSON array')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(within(indexRow()).getByRole('spinbutton'), { target: { value: '' } });
    expect(ctx.update).toHaveBeenCalledWith({
      target: { $var: { path: 'PLC:Steps' } },
      value: [],
    });
  });
});

describe('If editor', () => {
  it('opens the condition picker on Boolean variables', async () => {
    const ctx = makeCtx();
    const Editor = ACTION_EDITORS.if!;
    render(<Editor action={{ type: 'if', condition: { $var: { path: '' } } }} ctx={ctx} />);
    const row = screen.getByText('Condition').closest('.cfg-field-group') as HTMLElement;
    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: 'Change variable binding' }));
    const options = vi.mocked(ctx.openBindingPicker).mock.calls[0][2];
    expect(options?.filter).toEqual({ label: 'Condition', type: 'Boolean' });
  });
});
