import { act, fireEvent, render } from '@testing-library/react';
import { Profiler, useState } from 'react';
import * as datasourceTreeHelpers from '@config/components/ui/datasourceTreeHelpers';
import { useVariableStore } from '@hmi/store/variableStore';
import type { FolderEntry, VariableEntry } from '@shared/types/datasource';
import { FolderRowCells, ArrayElementRowCells, VariableRowCells } from './rowRenderers';

vi.mock('@config/components/ui/datasourceTreeHelpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@config/components/ui/datasourceTreeHelpers')>();
  return {
    ...actual,
    countVars: vi.fn(actual.countVars),
    countEnabledVars: vi.fn(actual.countEnabledVars),
  };
});

// Stable across re-renders so FolderRowCells' React.memo comparison isn't
// defeated by fresh closures on every parent render.
const noopToggleFolder = () => {};
const noopSetFolderEnabled = () => {};
const noopRemoveNode = () => {};

describe('FolderRowCells memoization (§7.2)', () => {
  const folder: FolderEntry = {
    kind: 'folder',
    name: 'Motors',
    children: [
      { kind: 'variable', display_name: 'Speed', data_type: 'Float', enabled: true },
      { kind: 'variable', display_name: 'Torque', data_type: 'Float', enabled: false },
    ],
  };
  const collapsed = new Set<string>();

  beforeEach(() => {
    vi.mocked(datasourceTreeHelpers.countVars).mockClear();
    vi.mocked(datasourceTreeHelpers.countEnabledVars).mockClear();
  });

  it('does not re-walk the subtree when the parent re-renders with unchanged props', () => {
    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button onClick={() => setTick((t) => t + 1)}>tick</button>
          <span data-testid="tick">{tick}</span>
          <FolderRowCells
            folder={folder}
            depth={0}
            path="Motors"
            collapsed={collapsed}
            showLive={false}
            isEditable={false}
            onToggleFolder={noopToggleFolder}
            onSetFolderEnabled={noopSetFolderEnabled}
            onRemoveNode={noopRemoveNode}
          />
        </>
      );
    }

    const { getByText, getByTestId } = render(<Harness />);
    expect(datasourceTreeHelpers.countVars).toHaveBeenCalledTimes(1);
    expect(datasourceTreeHelpers.countEnabledVars).toHaveBeenCalledTimes(1);

    // Simulate an unrelated re-render — analogous to a live-value tick that
    // touches state above FolderRowCells but not any of its own props.
    act(() => {
      getByText('tick').click();
    });

    expect(getByTestId('tick').textContent).toBe('1');
    // React.memo bails out entirely, so the subtree-counting helpers must
    // not be re-invoked for a render that didn't change any folder prop.
    expect(datasourceTreeHelpers.countVars).toHaveBeenCalledTimes(1);
    expect(datasourceTreeHelpers.countEnabledVars).toHaveBeenCalledTimes(1);
  });
});

describe('VariableRowCells min/max range editing', () => {
  const numericEntry: VariableEntry = {
    kind: 'variable',
    display_name: 'Speed',
    data_type: 'Double',
    enabled: true,
    writable: true,
  };

  function renderRow(entry: VariableEntry, overrides: { rangeEditable?: boolean } = {}) {
    const onUpdateVar = vi.fn();
    const utils = render(
      <VariableRowCells
        entry={entry}
        depth={0}
        path="Motor/Speed"
        dsName="PLC1"
        dsType="opcua-client"
        showLive={false}
        isEditable={false}
        rangeEditable={overrides.rangeEditable ?? true}
        liveValues={{}}
        onUpdateVar={onUpdateVar}
        onRemoveNode={() => {}}
      />,
    );
    return { ...utils, onUpdateVar };
  }

  it('commits a typed bound on blur, patching the variable at its own path', () => {
    const { getByLabelText, onUpdateVar } = renderRow(numericEntry);
    const min = getByLabelText('Minimum value');

    fireEvent.change(min, { target: { value: '10' } });
    fireEvent.blur(min);

    expect(onUpdateVar).toHaveBeenCalledWith('Motor/Speed', undefined, { min: 10 });
  });

  it('clears a bound when the field is emptied', () => {
    const { getByLabelText, onUpdateVar } = renderRow({ ...numericEntry, max: 100 });
    const max = getByLabelText('Maximum value');
    expect((max as HTMLInputElement).value).toBe('100');

    fireEvent.change(max, { target: { value: '' } });
    fireEvent.blur(max);

    expect(onUpdateVar).toHaveBeenCalledWith('Motor/Speed', undefined, { max: undefined });
  });

  it('refuses an inverted range instead of persisting one the write path cannot enforce', () => {
    const { getByLabelText, onUpdateVar } = renderRow({ ...numericEntry, max: 50 });
    const min = getByLabelText('Minimum value');

    fireEvent.change(min, { target: { value: '80' } });
    expect(min).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(min);

    expect(onUpdateVar).not.toHaveBeenCalled();
    // The refused text stays on screen, flagged, rather than silently reverting.
    expect((min as HTMLInputElement).value).toBe('80');
  });

  it('refuses text that is not a number', () => {
    const { getByLabelText, onUpdateVar } = renderRow(numericEntry);
    const max = getByLabelText('Maximum value');

    fireEvent.change(max, { target: { value: 'abc' } });
    fireEvent.blur(max);

    expect(onUpdateVar).not.toHaveBeenCalled();
    expect(max).toHaveAttribute('aria-invalid', 'true');
  });

  it('reverts the draft on Escape', () => {
    const { getByLabelText, onUpdateVar } = renderRow({ ...numericEntry, min: 5 });
    const min = getByLabelText('Minimum value');

    fireEvent.change(min, { target: { value: '7' } });
    fireEvent.keyDown(min, { key: 'Escape' });
    fireEvent.blur(min);

    expect(onUpdateVar).not.toHaveBeenCalled();
    expect((min as HTMLInputElement).value).toBe('5');
  });

  it('offers no range editor on a non-numeric variable', () => {
    const { queryByLabelText } = renderRow({ ...numericEntry, data_type: 'String' });
    expect(queryByLabelText('Minimum value')).toBeNull();
    expect(queryByLabelText('Maximum value')).toBeNull();
  });

  it('shows a stored bound read-only on a cloned array-struct element', () => {
    const { queryByLabelText, getByText } = renderRow(
      { ...numericEntry, min: 0, max: 3000 },
      { rangeEditable: false },
    );
    expect(queryByLabelText('Minimum value')).toBeNull();
    expect(getByText('3000')).toBeTruthy();
  });
});

describe('ArrayElementRowCells granular subscription (§7.3)', () => {
  const parent: VariableEntry = {
    kind: 'variable',
    display_name: 'Values',
    data_type: 'Int32',
    enabled: true,
    is_array: true,
    array_length: 3,
  };

  beforeEach(() => {
    useVariableStore.setState({
      values: { 'PLC1:Values': [1, 2, 3] },
      varMeta: {},
      snapshotReceived: true,
      contextReadyPageIds: [],
      wsConnected: true,
      opcuaConnected: {},
    });
  });

  it('re-renders only the element row whose value actually changed', () => {
    const renderCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0 };

    function Row({ index }: { index: number }) {
      return (
        <Profiler
          id={`row-${index}`}
          onRender={() => {
            renderCounts[index] += 1;
          }}
        >
          <ArrayElementRowCells
            parent={parent}
            index={index}
            depth={1}
            path="Values"
            dsName="PLC1"
            dsType="opcua-client"
            showLive
            isEditable={false}
          />
        </Profiler>
      );
    }

    render(
      <>
        <Row index={0} />
        <Row index={1} />
        <Row index={2} />
      </>,
    );

    expect(renderCounts).toEqual({ 0: 1, 1: 1, 2: 1 });

    // Whole-array replacement (as the store always does), but only index 1's
    // value actually changed.
    act(() => {
      useVariableStore.setState((s) => ({
        values: { ...s.values, 'PLC1:Values': [1, 999, 3] },
      }));
    });

    expect(renderCounts).toEqual({ 0: 1, 1: 2, 2: 1 });
  });
});
