import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('lists every ButtonAction discriminator in the Add dropdown', async () => {
    const user = userEvent.setup();
    render(<Harness onChangeSpy={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option').map((o) => o.textContent);
    for (const { label } of ACTION_TYPES) {
      expect(options).toContain(label);
    }
  });

  it.each(ACTION_TYPES)(
    'constructs the documented default payload for "$type" via the Add dropdown',
    async ({ type, label }) => {
      const onChangeSpy = vi.fn();
      const user = userEvent.setup();
      render(<Harness onChangeSpy={onChangeSpy} />);
      await pick(user, screen.getByRole('combobox'), label);

      const expected = makeDefaultAction(type, { overlayTargets: overlayTargetsFromStore() });
      expect(onChangeSpy).toHaveBeenCalledWith({ onPress: [expected] });
    },
  );
});

describe('ActionsInput — browse drawer', () => {
  beforeEach(setupStores);

  beforeAll(stubIntersectionObserver);

  it('leads the Add dropdown with a browse row that opens the categorised drawer', async () => {
    const user = userEvent.setup();
    render(<Harness onChangeSpy={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));

    const [first] = screen.getAllByRole('option');
    expect(first).toHaveAccessibleName('Browse actions…');
    await user.click(first);

    expect(screen.getByRole('heading', { name: /Add action/ })).toBeInTheDocument();
    for (const category of ['Screens', 'Machine', 'Session', 'Interface']) {
      expect(screen.getByRole('button', { name: category })).toBeInTheDocument();
    }
  });

  it('adds the action picked in the drawer and closes it', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, screen.getByRole('combobox'), 'Browse actions…');
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
    await pick(user, screen.getByRole('combobox'), 'Browse actions…');

    const search = screen.getByRole('searchbox', { name: 'Search actions' });
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
    await pick(user, screen.getByRole('combobox'), 'Open Dialog');

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
    await pick(user, screen.getByRole('combobox'), 'Open Page As Overlay');

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
    await pick(user, screen.getByRole('combobox'), 'Close Dialog/Overlay');
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
    await pick(user, screen.getByRole('combobox'), 'Show Toast');

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
    await pick(user, screen.getByRole('combobox'), 'Write Data Variable');

    expect(screen.getByText('On Success')).toBeInTheDocument();
    expect(screen.getByText('On Failed')).toBeInTheDocument();
    expect(screen.getByText('On Settled')).toBeInTheDocument();

    const onSuccessAdd = within(actionsGroup('On Success')).getByRole('combobox');
    await pick(user, onSuccessAdd, 'Logout User');

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
    await pick(user, screen.getByRole('combobox'), 'Show Alert');

    expect(screen.getByText('On Cancel')).toBeInTheDocument();
    expect(screen.getByText('On OK')).toBeInTheDocument();

    await pick(user, within(actionsGroup('On OK')).getByRole('combobox'), 'Set Theme');
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
    await pick(user, screen.getByRole('combobox'), 'Login User');
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

    await pick(user, screen.getByRole('combobox'), 'Logout User');
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
      datasource: 'PLC',
      path: 'Motor/Speed',
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
      datasource: 'PLC',
      path: 'Motor/Speed',
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
      datasource: 'PLC',
      path: 'Motor/Speed',
      value: 42,
    };
    render(<Harness onChangeSpy={onChangeSpy} initial={{ onPress: [write] }} />);

    await user.click(screen.getByTitle('Expand'));
    await user.click(screen.getByTitle('Change variable binding'));
    useEditorDomainStore
      .getState()
      .bindingPickerTarget?.onPick?.({ path: 'PLC:Motor/Torque' }, { dataType: 'Float' });

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      onPress: [{ ...write, path: 'Motor/Torque', value: 0 }],
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
          fieldPath: ['actions', 'onPress', '0', 'datasource'],
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
      datasource: 'Sim',
      path: 'Motor/Speed',
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
