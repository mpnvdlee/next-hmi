import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonAction } from '@shared/types/config';
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
    dialogs: [],
    allPages: [],
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
// Placement field's own group since Dialog/Size/Placement are all rendered
// as comboboxes simultaneously.
async function openPlacementSelect() {
  const user = userEvent.setup();
  const fieldGroup = screen.getByText('Placement').closest('.cfg-field-group') as HTMLElement;
  await user.click(within(fieldGroup).getByRole('combobox'));
}

describe('Placement select', () => {
  it('lists every placement option for the openDialog action', async () => {
    const action: Extract<ButtonAction, { type: 'openDialog' }> = {
      type: 'openDialog',
      dialogId: '',
    };
    const OpenDialogEditor = ACTION_EDITORS.openDialog!;
    render(<OpenDialogEditor action={action} ctx={makeCtx()} />);

    await openPlacementSelect();

    for (const label of EXPECTED_PLACEMENT_LABELS) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('lists the identical set of placement options for the openPageOverlay action', async () => {
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
