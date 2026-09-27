import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import VariableBindingPicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useEditorDomainStore.getState().closeBindingPicker();
});

describe('VariableBindingPicker search', () => {
  it('confirms the first selectable search result with Enter', async () => {
    const onPick = vi.fn();
    mockedApiJson
      .mockResolvedValueOnce([{ name: 'Demo PLC', type: 'static' }] as never)
      .mockResolvedValueOnce({
        variables: [
          {
            display_name: 'Top Speed',
            data_type: 'Float',
            enabled: true,
            writable: true,
          },
        ],
      } as never);

    useEditorDomainStore.getState().openBindingPicker('', 'speed', {
      onPick,
      filter: { type: 'Float' },
    });
    render(<VariableBindingPicker />);

    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(1));
    const search = screen.getByRole('searchbox', { name: 'Search speed' });
    fireEvent.change(search, { target: { value: 'speed' } });

    await waitFor(() => {
      expect(document.querySelector('.editor-binding-list > div')).toHaveStyle({ height: '52px' });
    });
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith(
        { path: 'Demo PLC:Top Speed' },
        expect.objectContaining({ dataType: 'Float', isArray: false }),
      );
    });
  });

  it('preselects currentBinding when the binding lives outside a component property', async () => {
    const onPick = vi.fn();
    mockedApiJson
      .mockResolvedValueOnce([{ name: 'Demo PLC', type: 'static' }] as never)
      .mockResolvedValueOnce({
        variables: [
          {
            display_name: 'Top Speed',
            data_type: 'Float',
            enabled: true,
            writable: true,
          },
        ],
      } as never);

    useEditorDomainStore.getState().openBindingPicker('', 'writeDataVariable', {
      onPick,
      currentBinding: { path: 'Demo PLC:Top Speed' },
      filter: { type: 'Float', write: true },
    });
    render(<VariableBindingPicker />);

    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(2));
    const confirm = screen.getByRole('button', { name: /Confirm/ });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    expect(onPick).toHaveBeenCalledWith(
      { path: 'Demo PLC:Top Speed' },
      expect.objectContaining({ dataType: 'Float' }),
    );
  });
});

describe('VariableBindingPicker component-prop mode', () => {
  function openComponentPropPicker() {
    useEditorDomainStore.getState().openBindingPicker('', 'iconName', {
      componentPropSource: {
        properties: {
          icon: { type: 'icon', label: 'Icon name' },
          label: { type: 'string', label: 'Label' },
          running: { type: 'boolean', label: 'Running' },
        },
        fieldType: 'icon',
        label: 'Icon',
        onPick: vi.fn(),
      },
    });
  }

  // The list is virtualized and jsdom reports zero height, so no row renders.
  // The spacer height is the row count: 26px per row.
  function renderedRowCount(): number {
    const spacer = document.querySelector('.editor-binding-list > div') as HTMLElement | null;
    return Number.parseInt(spacer?.style.height ?? '0', 10) / 26;
  }

  it('heads the list with the source the properties come from', () => {
    openComponentPropPicker();
    render(<VariableBindingPicker />);

    // Source row + the icon property and the String one an icon field binds, as
    // a String variable would; `running` is filtered out by type.
    expect(renderedRowCount()).toBe(3);
  });

  it('titles the drawer with the property being bound', () => {
    openComponentPropPicker();
    render(<VariableBindingPicker />);

    const heading = screen.getByRole('heading', { name: /Select property/ });
    expect(heading).toHaveTextContent('Icon');
    expect(heading).toHaveTextContent('Select property');
  });
});

describe('VariableBindingPicker inside a Repeater', () => {
  const STRUCT_SCOPE = {
    members: ['Name', 'Speed'],
    writable: true,
    elementType: 'struct',
    memberTypes: { Speed: 'Float' },
  };

  function confirmButton() {
    return screen.getByRole('button', { name: /Confirm/ });
  }

  it('confirms the repeat item the field reads today', async () => {
    mockedApiJson.mockResolvedValue([] as never);
    const onPick = vi.fn();
    const onBinding = vi.fn();
    useEditorDomainStore.getState().openBindingPicker('', 'label', {
      onPick: onBinding,
      repeatItem: { scope: STRUCT_SCOPE, current: { field: 'value', member: 'Speed' }, onPick },
    });
    render(<VariableBindingPicker />);

    expect(screen.getByText('Repeat item › Speed')).toBeInTheDocument();
    fireEvent.click(confirmButton());

    expect(onPick).toHaveBeenCalledWith({ field: 'value', member: 'Speed' });
    expect(onBinding).not.toHaveBeenCalled();
  });

  it('lists only the copy, never the datasources, in Repeat item mode', () => {
    useEditorDomainStore.getState().openBindingPicker('', 'label', {
      repeatItem: { scope: STRUCT_SCOPE, onPick: vi.fn() },
    });
    render(<VariableBindingPicker />);
    expect(mockedApiJson).not.toHaveBeenCalled();
  });

  it('will not write a whole struct element', () => {
    mockedApiJson.mockResolvedValue([] as never);
    useEditorDomainStore.getState().openBindingPicker('', 'writeDataVariable', {
      repeatItem: {
        scope: STRUCT_SCOPE,
        writeTarget: true,
        current: { field: 'value' },
        onPick: vi.fn(),
      },
    });
    render(<VariableBindingPicker />);

    expect(confirmButton()).toBeDisabled();
  });

  it("confirms a parallel array at the copy's own index", async () => {
    mockedApiJson.mockResolvedValue([] as never);
    const onPick = vi.fn();
    useEditorDomainStore.getState().openBindingPicker('', 'label', {
      onPick,
      currentBinding: { path: 'PLC:Names', repeatIndex: true },
      repeatIndex: true,
    });
    render(<VariableBindingPicker />);

    fireEvent.click(confirmButton());

    expect(onPick).toHaveBeenCalledWith({ path: 'PLC:Names', repeatIndex: true }, undefined);
  });
});

describe('VariableBindingPicker verdicts', () => {
  function verdict(): string | null {
    const header = document.querySelector('.editor-binding-requirements .editor-binding-req-row');
    return header?.querySelector('.editor-binding-char-row__match-slot')?.textContent ?? null;
  }

  const SCOPE = {
    members: ['Name', 'Speed'],
    writable: true,
    elementType: 'struct',
    memberTypes: { Speed: 'Float', Name: 'String' },
  };

  it.each([
    ['a Float member for a Float field', { type: 'Float' }, { member: 'Speed' }, '✓'],
    ['a String member for a Float field', { type: 'Float' }, { member: 'Name' }, '✗'],
    [
      'the index for a writable field',
      { type: 'Integer', write: true },
      { field: 'index' as const },
      '✗',
    ],
    ['the index for an Integer field', { type: 'Integer' }, { field: 'index' as const }, '✓'],
  ])('judges %s', (_name, filter, current, expected) => {
    mockedApiJson.mockResolvedValue([] as never);
    useEditorDomainStore.getState().openBindingPicker('', 'value', {
      filter,
      repeatItem: { scope: SCOPE, current: { field: 'value', ...current }, onPick: vi.fn() },
    });
    render(<VariableBindingPicker />);
    expect(verdict()).toBe(expected);
  });

  it('marks a component property that no longer exists', () => {
    useEditorDomainStore.getState().openBindingPicker('', 'label', {
      componentPropSource: {
        properties: { label: { type: 'string', label: 'Label' } },
        onPick: vi.fn(),
        currentKey: 'gone',
      },
    });
    render(<VariableBindingPicker />);
    expect(verdict()).toBe('✗');
  });

  it('accepts any property for an untyped field', () => {
    useEditorDomainStore.getState().openBindingPicker('', 'label', {
      componentPropSource: {
        properties: { label: { type: 'string', label: 'Label' } },
        onPick: vi.fn(),
        currentKey: 'label',
      },
    });
    render(<VariableBindingPicker />);
    expect(verdict()).toBe('✓');
  });
});
