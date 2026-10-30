import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '@shared/store/configStore';
import { usePanelExpansionStore } from '@config/store/panelExpansionStore';
import { flattenPageNodes } from '@shared/utils/pageTree';
import type { ActionsConfig, ButtonAction } from '@shared/types/config';
import { ACTION_TYPES } from './actionsPreview';
import { makeDefaultAction } from './actionMutations';
import ActionsInput from './ActionsInput';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { ComponentPropertySchemaContext } from '../PropertySourceEditor/componentPropertySchemaContext';
import { usePanelDiagnostics } from '@config/hooks/usePanelDiagnostics';
import { apiJson } from '@shared/utils/api';
import { stubIntersectionObserver } from '../../../../test-setup';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));
const mockedApiJson = vi.mocked(apiJson);

/** Drives the diagnostics store off the mocked /api/config/validate response. */
function DiagnosticsHarness() {
  usePanelDiagnostics({ kind: 'page', id: null, draft: {} });
  return null;
}

// jsdom doesn't implement scrollIntoView; the custom Select's popup calls it.
Element.prototype.scrollIntoView = vi.fn();

function setupStores() {
  useConfigStore.setState({
    dialogs: [
      { id: 'dlg1', title: 'Settings', type: 'page', sections: { content: [] } },
      {
        id: 'dlg2',
        title: 'Confirm',
        type: 'page',
        sections: { content: [] },
        componentProperties: { motorId: { type: 'string', label: 'Motor ID' } },
      },
    ],
    pages: [
      { id: 'page1', type: 'page', title: 'Home', sections: { main: [] } },
      { id: 'page2', type: 'page', title: 'Settings Page', sections: { main: [] } },
    ],
  });
  usePanelExpansionStore.setState({ expanded: {} });
}

/** Overlay targets built the same way `ActionsInput` builds them, for
 *  computing the same default payload `makeDefaultAction` would return. */
function overlayTargetsFromStore() {
  const { dialogs, pages } = useConfigStore.getState();
  return { dialogs: flattenPageNodes(dialogs), pages: flattenPageNodes(pages) };
}

function fieldGroup(label: string): HTMLElement {
  return screen.getByText(label).closest('.cfg-field-group') as HTMLElement;
}

/** Nested result-handler / showAlert action lists ("On Success", "On OK", …)
 *  render as a bare `.cfg-editor-actions` block, not a `.cfg-field-group`. */
function actionsGroup(label: string): HTMLElement {
  return screen.getByText(label).closest('.cfg-editor-actions') as HTMLElement;
}

/** The custom `Select` is a button+portal listbox, not a native `<select>` —
 *  open it, then click the option by its visible label. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  optionName: string,
): Promise<void> {
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: optionName }));
}

/** Add opens the action drawer; click the card whose name starts with `label`.
 *  `scope` narrows to one list's Add when nested lists render their own. */
async function addAction(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  scope: HTMLElement = document.body,
): Promise<void> {
  await user.click(within(scope).getByTitle('Add action'));
  await user.click(screen.getByRole('button', { name: (name) => name.startsWith(label) }));
}

beforeAll(stubIntersectionObserver);

function Harness({
  initial,
  onChangeSpy,
  eventKey,
  resultFields,
  pathPrefix,
}: {
  initial?: ActionsConfig;
  onChangeSpy: (v: unknown) => void;
  eventKey?: string;
  resultFields?: string[];
  pathPrefix?: string[];
}) {
  const [value, setValue] = useState<ActionsConfig | undefined>(initial);
  return (
    <ActionsInput
      value={value}
      onChange={(v) => {
        onChangeSpy(v);
        setValue(v as ActionsConfig);
      }}
      eventKey={eventKey}
      resultFields={resultFields}
      pathPrefix={pathPrefix}
    />
  );
}

describe('ActionsInput — full discriminator sweep', () => {
  beforeEach(setupStores);

  it('lists every ButtonAction discriminator in the drawer Add opens', async () => {
    const user = userEvent.setup();
    render(<Harness onChangeSpy={vi.fn()} />);
    await user.click(screen.getByTitle('Add action'));

    for (const { label } of ACTION_TYPES) {
      expect(
        screen.getByRole('button', { name: (name) => name.startsWith(label) }),
      ).toBeInTheDocument();
    }
  });

  it.each(ACTION_TYPES)(
    'constructs the documented default payload for "$type" via the drawer',
    async ({ type, label }) => {
      const onChangeSpy = vi.fn();
      const user = userEvent.setup();
      render(<Harness onChangeSpy={onChangeSpy} />);
      await addAction(user, label);

      const expected = makeDefaultAction(type, { overlayTargets: overlayTargetsFromStore() });
      expect(onChangeSpy).toHaveBeenCalledWith({ onPress: [expected] });
    },
  );
});

describe('ActionsInput — paste', () => {
  beforeEach(setupStores);

  it('appends a copied action with the drawer’s Paste action button', async () => {
    const existing: ButtonAction = { type: 'logoutUser' };
    const copied: ButtonAction = {
      type: 'showToast',
      message: 'Hi',
      severity: 'info',
      discard: 'auto',
    };
    const onChangeSpy = vi.fn();
    // userEvent.setup() installs the clipboard stub the paste reads from.
    const user = userEvent.setup();
    await navigator.clipboard.writeText(JSON.stringify({ $static: copied }));
    render(<Harness initial={{ onPress: [existing] }} onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));
    await user.click(screen.getByRole('button', { name: 'Paste action' }));

    await waitFor(() => expect(onChangeSpy).toHaveBeenCalledWith({ onPress: [existing, copied] }));
    expect(screen.queryByRole('heading', { name: /Add action/ })).not.toBeInTheDocument();
  });

  it('appends a copied action pasted with Ctrl+V in the drawer', async () => {
    const copied: ButtonAction = { type: 'logoutUser' };
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));

    fireEvent.paste(screen.getByRole('searchbox'), {
      clipboardData: { getData: () => JSON.stringify({ $static: copied }) },
    });

    expect(onChangeSpy).toHaveBeenCalledWith({ onPress: [copied] });
    expect(screen.queryByRole('heading', { name: /Add action/ })).not.toBeInTheDocument();
  });

  it('leaves plain text pasted into the drawer’s search to the search', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));

    fireEvent.paste(screen.getByRole('searchbox'), {
      clipboardData: { getData: () => 'toast' },
    });

    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Add action/ })).toBeInTheDocument();
  });
});

describe('ActionsInput — browse drawer', () => {
  beforeEach(setupStores);

  beforeAll(stubIntersectionObserver);

  it('opens the categorised drawer straight from Add', async () => {
    const user = userEvent.setup();
    render(<Harness onChangeSpy={vi.fn()} />);
    await user.click(screen.getByTitle('Add action'));

    expect(screen.getByRole('heading', { name: /Add action/ })).toBeInTheDocument();
    for (const category of ['Screens', 'Machine', 'Session', 'Interface']) {
      expect(screen.getByRole('button', { name: category })).toBeInTheDocument();
    }
  });

  it('closes the drawer on Escape without adding anything', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('heading', { name: /Add action/ })).not.toBeInTheDocument();
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('adds the action picked in the drawer and closes it', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));
    await user.click(screen.getByRole('button', { name: /Show Toast/ }));

    expect(onChangeSpy).toHaveBeenCalledWith({
      onPress: [makeDefaultAction('showToast', { overlayTargets: overlayTargetsFromStore() })],
    });
    expect(screen.queryByRole('heading', { name: /Add action/ })).not.toBeInTheDocument();
  });

  it('adds the top search match when Enter is pressed', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await user.click(screen.getByTitle('Add action'));

    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'theme' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChangeSpy).toHaveBeenCalledWith({
      onPress: [expect.objectContaining({ type: 'setActiveTheme' })],
    });
  });
});

describe('ActionsInput — page-overlay routing', () => {
  beforeEach(setupStores);

  it('openDialog: defaults to the first Dialogs-folder page and edits its declared input parameters', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Open Dialog');

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'openDialog',
          pageId: 'dlg1',
          componentProperties: {},
          size: 'medium',
          placement: 'center',
        },
      ],
    });

    await pick(user, within(fieldGroup('Dialog')).getByRole('combobox'), 'Confirm');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'openDialog',
          pageId: 'dlg2',
          componentProperties: {},
          size: 'medium',
          placement: 'center',
        },
      ],
    });

    // dlg2 declares a "Motor ID" input parameter — edit it through its own row.
    fireEvent.change(within(fieldGroup('Motor ID')).getByRole('textbox'), {
      target: { value: 'M1' },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'openDialog',
          pageId: 'dlg2',
          componentProperties: { motorId: 'M1' },
          size: 'medium',
          placement: 'center',
        },
      ],
    });
  });

  it('openPageOverlay: defaults to the first navigable page and takes no input parameters', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Open Page As Overlay');

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ type: 'openPageOverlay', pageId: 'page1', size: 'medium', placement: 'center' }],
    });

    await pick(user, within(fieldGroup('Page')).getByRole('combobox'), 'Settings Page');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ type: 'openPageOverlay', pageId: 'page2', size: 'medium', placement: 'center' }],
    });
    expect(screen.queryByText('Input Parameters')).not.toBeInTheDocument();
  });

  it('closePageOverlay: defaults to top-most overlay and can target a specific page', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Close Dialog/Overlay');
    expect(onChangeSpy).toHaveBeenLastCalledWith({ onPress: [{ type: 'closePageOverlay' }] });

    await pick(user, within(fieldGroup('Page')).getByRole('combobox'), 'Home');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ type: 'closePageOverlay', pageId: 'page1' }],
    });
  });
});

describe('ActionsInput — showToast arguments', () => {
  beforeEach(setupStores);

  it('edits message/severity/discard and shows the duration field only in auto-discard mode', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Show Toast');

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'showToast',
          message: { $static: '' },
          severity: 'info',
          discard: 'auto',
          duration: 4000,
        },
      ],
    });
    expect(within(fieldGroup('Duration (ms)')).getByRole('spinbutton')).toBeInTheDocument();

    await pick(user, within(fieldGroup('Severity')).getByRole('combobox'), 'Warning');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'showToast',
          message: { $static: '' },
          severity: 'warning',
          discard: 'auto',
          duration: 4000,
        },
      ],
    });

    await pick(user, within(fieldGroup('Discard')).getByRole('combobox'), 'Manual');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [
        {
          type: 'showToast',
          message: { $static: '' },
          severity: 'warning',
          discard: 'manual',
          duration: 4000,
        },
      ],
    });
    expect(screen.queryByText('Duration (ms)')).not.toBeInTheDocument();
  });
});

describe('ActionsInput — nested result handlers', () => {
  beforeEach(setupStores);

  it('writeDataVariable: accepts nested actions in onSuccess/onFailed/onSettled', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Write Data Variable');

    expect(screen.getByText('On Success')).toBeInTheDocument();
    expect(screen.getByText('On Failed')).toBeInTheDocument();
    expect(screen.getByText('On Settled')).toBeInTheDocument();

    await addAction(user, 'Logout User', actionsGroup('On Success'));

    const calls = onChangeSpy.mock.calls;
    const last = calls[calls.length - 1]?.[0] as ActionsConfig;
    const writeAction = last.onPress?.[0] as Extract<ButtonAction, { type: 'writeDataVariable' }>;
    expect(writeAction.type).toBe('writeDataVariable');
    expect(writeAction.onSuccess).toEqual([{ type: 'logoutUser' }]);
    expect(writeAction.onFailed ?? []).toEqual([]);
    expect(writeAction.onSettled ?? []).toEqual([]);
  });

  it('showAlert: accepts nested actions in onOk/onCancel', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await addAction(user, 'Show Alert');

    expect(screen.getByText('On Cancel')).toBeInTheDocument();
    expect(screen.getByText('On OK')).toBeInTheDocument();

    await addAction(user, 'Set Theme', actionsGroup('On OK'));
    const calls = onChangeSpy.mock.calls;
    const last = calls[calls.length - 1]?.[0] as ActionsConfig;
    const alertAction = last.onPress?.[0] as Extract<ButtonAction, { type: 'showAlert' }>;
    expect(alertAction.onOk).toEqual([{ type: 'setActiveTheme', theme: { $static: '' } }]);
    expect(alertAction.onCancel ?? []).toEqual([]);
  });

  it('exposes $result as a source inside a result-handler slot', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    // resultFields set simulates rendering inside another action's onSuccess/
    // onFailed/onSettled slot — the component gates on ctx.resultFields alone,
    // not on actual nesting depth.
    render(<Harness onChangeSpy={onChangeSpy} resultFields={['username']} />);
    await addAction(user, 'Login User');
    expect(screen.getByText('Username')).toBeInTheDocument();
  });
});

describe('ActionsInput — invalid payload recovery', () => {
  beforeEach(setupStores);

  it('renders a malformed/unknown action without crashing and allows removing it', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const malformed = { type: 'bogusAction', foo: 'bar' } as unknown as ButtonAction;
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [malformed] }} />);

    // No editor body renders for the unknown type, but the row itself (badge,
    // remove button) still does — no crash, no throw.
    expect(screen.getByTitle('Remove action')).toBeInTheDocument();

    await user.click(screen.getByTitle('Remove action'));
    expect(onChangeSpy).toHaveBeenCalledWith({ onPress: [] });
  });

  it('still allows adding a valid action after an unknown one is present', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const malformed = { type: 'bogusAction' } as unknown as ButtonAction;
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [malformed] }} />);

    await addAction(user, 'Logout User');
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [malformed, { type: 'logoutUser' }],
    });
  });
});

describe('ActionsInput — write target', () => {
  beforeEach(setupStores);

  it('opens the picker on the variable the action already writes', async () => {
    const user = userEvent.setup();
    const write: ButtonAction = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Motor/Speed' } },
      value: 1,
    };
    render(<Harness onChangeSpy={vi.fn()} initial={{ onPress: [write] }} />);

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));

    expect(useEditorDomainStore.getState().bindingPickerTarget).toMatchObject({
      propertyKey: 'writeDataVariable',
      currentBinding: { path: 'PLC:Motor/Speed' },
    });
  });

  it('keeps the authored value when the picker confirms the same target', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const write: ButtonAction = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Motor/Speed' } },
      value: 42,
    };
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [write] }} />);

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));
    // Confirming the preselected row re-picks the binding the action already has.
    useEditorDomainStore
      .getState()
      .bindingPickerTarget?.onPick?.({ path: 'PLC:Motor/Speed' }, { dataType: 'Float' });

    expect(onChangeSpy).toHaveBeenLastCalledWith({ onPress: [write] });
  });

  it('resets the value when the picker retargets the action elsewhere', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const write: ButtonAction = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Motor/Speed' } },
      value: 42,
    };
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [write] }} />);

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));
    useEditorDomainStore
      .getState()
      .bindingPickerTarget?.onPick?.({ path: 'PLC:Motor/Torque' }, { dataType: 'Float' });

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ ...write, target: { $var: { path: 'PLC:Motor/Torque' } }, value: 0 }],
    });
  });

  it('summarises a bound index as path[…] and replaces it with the element the picker picks', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const toggle: ButtonAction = {
      type: 'toggleDataVariable',
      target: { $var: { path: 'PLC:Open', index: { $componentProp: 'device' } } },
    };
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [toggle] }} />);
    expect(document.body).toHaveTextContent('Toggle PLC:Open[…]');

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));
    const target = useEditorDomainStore.getState().bindingPickerTarget;
    expect(target?.currentBinding).toEqual({ path: 'PLC:Open' });
    target?.onPick?.({ path: 'PLC:Open' }, { dataType: 'Boolean', isArray: true, index: 2 });

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ ...toggle, target: { $var: { path: 'PLC:Open[2]' } } }],
    });
  });

  it('keeps a bound index when the picker confirms the same array, and resets the value for an element', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const write: ButtonAction = {
      type: 'writeDataVariable',
      target: { $var: { path: 'PLC:Steps', index: { $componentProp: 'device' } } },
      value: 42,
    };
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [write] }} />);

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));
    const target = useEditorDomainStore.getState().bindingPickerTarget;
    target?.onPick?.({ path: 'PLC:Steps' }, { dataType: 'Int16', isArray: true });
    expect(onChangeSpy).not.toHaveBeenCalled();

    target?.onPick?.({ path: 'PLC:Steps' }, { dataType: 'Int16', isArray: true, index: 2 });
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ ...write, target: { $var: { path: 'PLC:Steps[2]' } }, value: 0 }],
    });
  });

  it('marks the action row and its Variable row when the backend rejects the target', async () => {
    mockedApiJson.mockResolvedValue({
      diagnostics: [
        {
          artifactId: 'page-1',
          artifactKind: 'page',
          widgetId: 'btn-1',
          propKey: 'actions',
          fieldPath: ['actions', 'onPress', '0', 'target'],
          code: 'var-test-server',
          severity: 'error',
          message: "datasource 'Sim' is an OPC-UA test server",
          breadcrumb: 'Button › actions',
          nested: true,
        },
      ],
    } as never);
    const user = userEvent.setup();
    const write: ButtonAction = {
      type: 'writeDataVariable',
      target: { $var: { path: 'Sim:Motor/Speed' } },
      value: 1,
    };
    render(
      <PanelScopeContext.Provider value="btn-1">
        <DiagnosticsHarness />
        <Harness onChangeSpy={vi.fn()} initial={{ onPress: [write] }} pathPrefix={['actions']} />
      </PanelScopeContext.Provider>,
    );

    // Collapsed row: badge dot only (the diagnostic targets a sub-slot).
    await waitFor(() => {
      expect(document.querySelector('.cfg-field-group__badge--invalid')).toBeInTheDocument();
    });

    // Expanded: the Variable row owning the target gets the full error mark.
    await user.click(screen.getByTitle('Expand'));
    expect(fieldGroup('Variable')).toHaveClass('cfg-field-group--invalid');
  });
});

describe('ActionsInput — Navigate To Page in a dialog', () => {
  beforeEach(setupStores);
  afterEach(() => useEditorDomainStore.getState().closeBindingPicker());

  it('offers only the input parameters of type Page', async () => {
    const user = userEvent.setup();
    const inputs = {
      properties: {
        target: { type: 'string', format: 'page', label: 'Target' },
        title: { type: 'string', label: 'Title' },
      },
    };
    render(
      <ComponentPropertySchemaContext.Provider value={inputs}>
        <Harness
          onChangeSpy={vi.fn()}
          initial={{ onPress: [{ type: 'navigateToPage', pageId: { $componentProp: '' } }] }}
        />
      </ComponentPropertySchemaContext.Provider>,
    );

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByRole('button', { name: 'Select component property' }));

    const source = useEditorDomainStore.getState().bindingPickerTarget?.componentPropSource;
    expect(Object.keys(source?.properties ?? {})).toEqual(['target']);
  });
});

describe('ActionsInput — a write target inside a component', () => {
  beforeEach(setupStores);
  afterEach(() => useEditorDomainStore.getState().closeBindingPicker());

  it('targets an input parameter the instance fills with a writable variable', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    const inputs = {
      properties: {
        value: { type: 'float', label: 'Value', write: true },
        label: { type: 'string', label: 'Name' },
      },
    };
    render(
      <ComponentPropertySchemaContext.Provider value={inputs}>
        <Harness
          onChangeSpy={onChangeSpy}
          initial={{ onPress: [{ type: 'editValue', target: { $componentProp: '' } }] }}
        />
      </ComponentPropertySchemaContext.Provider>,
    );

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByRole('button', { name: 'Select component property' }));

    const source = useEditorDomainStore.getState().bindingPickerTarget?.componentPropSource;
    expect(source?.write).toBe(true);
    expect(source?.fieldType).toEqual(['Integer', 'Float']);
    act(() => source?.onPick('value'));
    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ type: 'editValue', target: { $componentProp: 'value' } }],
    });
  });
});
