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

    // Source row + the one icon-typed property; `label` is filtered out by type.
    expect(renderedRowCount()).toBe(2);
  });

  it('titles the drawer with the property being bound', () => {
    openComponentPropPicker();
    render(<VariableBindingPicker />);

    const heading = screen.getByRole('heading', { name: /Select property/ });
    expect(heading).toHaveTextContent('Icon');
    expect(heading).toHaveTextContent('Select property');
  });
});
