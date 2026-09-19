import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonAction, PageConfig, PageNode } from '@shared/types/config';
import type ActionsInputType from './ActionsInput';
import { ACTION_EDITORS, type ActionEditorCtx } from './actionEditors';

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
  const page = { id: 'p1', title: 'Machine', type: 'page', sections: { content: [] } } as PageConfig;
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
      datasource: 'PLC',
      path: 'Counter',
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
      datasource: 'PLC',
      path: 'Steps',
      value: [1],
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Steps'] = { dataType: 'Int16', isArray: true, arrayLength: 2 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.getByPlaceholderText('JSON array')).toHaveValue('[1]');
    expect(screen.getByRole('alert')).toHaveTextContent('array_length_mismatch');
  });

  it('predicts backend rejection of a literal outside the configured min/max', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      datasource: 'PLC',
      path: 'Temp',
      value: 11,
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Temp'] = { dataType: 'Float', isArray: false, min: -20, max: 10 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.getByRole('alert')).toHaveTextContent('value_out_of_range');
  });

  it('accepts a literal within the configured min/max', () => {
    const action: Extract<ButtonAction, { type: 'writeDataVariable' }> = {
      type: 'writeDataVariable',
      datasource: 'PLC',
      path: 'Temp',
      value: 5,
    };
    const ctx = makeCtx();
    ctx.dataTypes['PLC:Temp'] = { dataType: 'Float', isArray: false, min: -20, max: 10 };
    const Editor = ACTION_EDITORS.writeDataVariable!;
    render(<Editor action={action} ctx={ctx} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
