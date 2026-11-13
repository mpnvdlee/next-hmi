import { localInputKey, readStoredValue, useVariableStore, type VarMeta } from './variableStore';

describe('readStoredValue', () => {
  const motor = 'PLC:Motors/M1/sstDev';
  const values = {
    [motor]: { Hmi: { stActualPosition: { fValue: 12.5 }, bVisible: false } },
    'PLC:Speed': 3,
  };

  it('reads a key with a value of its own as it is', () => {
    expect(readStoredValue(values, 'PLC:Speed')).toBe(3);
  });

  it('reads a member of a struct bound whole out of the struct', () => {
    expect(readStoredValue(values, `${motor}/Hmi/stActualPosition/fValue`)).toBe(12.5);
    expect(readStoredValue(values, `${motor}/Hmi/bVisible`)).toBe(false);
  });

  it('prefers a member key of its own over the struct', () => {
    const both = { ...values, [`${motor}/Hmi/bVisible`]: true };
    expect(readStoredValue(both, `${motor}/Hmi/bVisible`)).toBe(true);
  });

  it('reads nothing for a member the struct lacks, or with no ancestor stored', () => {
    expect(readStoredValue(values, `${motor}/Hmi/stNope/fValue`)).toBeUndefined();
    expect(readStoredValue(values, 'PLC:Other/x')).toBeUndefined();
    expect(readStoredValue(values, 'PLC:Speed/x')).toBeUndefined();
  });
});

const INTEGER: VarMeta = { type: { kind: 'scalar', base: 'Integer', array: false } };

describe('variableStore', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: {},
      varMeta: {},
      prevVarMeta: {},
      metadataReceived: false,
      snapshotReceived: false,
      contextReadyPageIds: [],
      wsConnected: false,
      opcuaConnected: {},
    });
  });

  it('stores scalar and struct values in one map when applying a batch', () => {
    useVariableStore.getState().applyBatch({
      'MyPLC:Motor/Speed': 42,
      'MyPLC:Motor/HMI': { bVisible: true, fValue: 12.5 },
    });

    const state = useVariableStore.getState();
    expect(state.values).toEqual({
      'MyPLC:Motor/Speed': 42,
      'MyPLC:Motor/HMI': { bVisible: true, fValue: 12.5 },
    });
  });

  it('keeps the unchanged elements of a struct array re-sent around one changed leaf', () => {
    const element = (n: number) => ({ nId: n, stInfo: { nState: n } });
    const { applyBatch } = useVariableStore.getState();
    applyBatch({ 'PLC:List': [element(0), element(1)] });
    const before = useVariableStore.getState().values['PLC:List'] as unknown[];

    applyBatch({ 'PLC:List': [element(0), { ...element(1), nId: 9 }] });
    const after = useVariableStore.getState().values['PLC:List'] as Record<string, unknown>[];
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toEqual({ nId: 9, stInfo: { nState: 1 } });
    expect(after[1].stInfo).toBe((before[1] as Record<string, unknown>).stInfo);
  });

  it('keeps the state for a batch that changes nothing, so no subscriber runs', () => {
    const { applyBatch } = useVariableStore.getState();
    applyBatch({ 'PLC:List': [{ nId: 1 }], 'PLC:A': 1 });
    const before = useVariableStore.getState();

    applyBatch({ 'PLC:List': [{ nId: 1 }], 'PLC:A': 1 });
    expect(useVariableStore.getState()).toBe(before);

    // A key the store lacks is still added, even with no value.
    applyBatch({ 'PLC:B': undefined });
    expect('PLC:B' in useVariableStore.getState().values).toBe(true);
  });

  it('removes variables from the value cache', () => {
    useVariableStore.setState({
      values: {
        'MyPLC:Motor/Speed': 42,
        'MyPLC:Motor/HMI': { bVisible: true },
      },
      varMeta: {
        'MyPLC:Motor/Speed': { type: { kind: 'scalar', base: 'Float', array: false } },
        'MyPLC:Motor/HMI': {
          type: { kind: 'struct', name: 'HMI', fields: ['bVisible'], array: false },
        },
      },
      prevVarMeta: { 'MyPLC:Motor/Speed': INTEGER },
    });

    useVariableStore.getState().removeVars(['MyPLC:Motor/Speed', 'MyPLC:Motor/HMI']);

    const state = useVariableStore.getState();
    expect(state.values).toEqual({});
    expect(state.varMeta).toEqual({});
    expect(state.prevVarMeta).toEqual({});
  });

  it('notifies no subscriber when none of the variables to remove is there', () => {
    useVariableStore.setState({
      values: { 'MyPLC:Motor/Speed': 42 },
      varMeta: {},
      prevVarMeta: {},
    });
    const listener = vi.fn();
    const unsubscribe = useVariableStore.subscribe(listener);

    useVariableStore.getState().removeVars(['$input:f1/name', 'MyPLC:Gone']);

    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(useVariableStore.getState().values).toEqual({ 'MyPLC:Motor/Speed': 42 });
  });

  it('replaces a snapshot generation instead of retaining old cached values', () => {
    useVariableStore.setState({ values: { 'OldPLC:Stale': 1 } });
    useVariableStore.getState().replaceValues({ 'NewPLC:Fresh': 2 });

    expect(useVariableStore.getState().values).toEqual({ 'NewPLC:Fresh': 2 });
  });

  it('replaces metadata per context but keeps the last values of keys outside it', () => {
    useVariableStore.setState({
      values: { 'PLC:ThisPage': 1, 'PLC:OtherPage': 2 },
      varMeta: {
        'PLC:ThisPage': { type: { kind: 'scalar', base: 'Integer', array: false } },
        'PLC:OtherPage': { type: { kind: 'scalar', base: 'Integer', array: false } },
      },
    });

    useVariableStore.getState().setVarMeta({
      'PLC:ThisPage': { type: { kind: 'scalar', base: 'Integer', array: false } },
    });

    // Navigating back to the other page shows its last value until fresh data lands.
    expect(useVariableStore.getState().values).toEqual({ 'PLC:ThisPage': 1, 'PLC:OtherPage': 2 });
    expect(Object.keys(useVariableStore.getState().varMeta)).toEqual(['PLC:ThisPage']);
  });

  it('keeps the values of the last three metadata frames only', () => {
    const { applyBatch, setVarMeta } = useVariableStore.getState();
    for (const page of ['A', 'B', 'C']) {
      setVarMeta({ [`PLC:${page}`]: INTEGER });
      applyBatch({ [`PLC:${page}`]: 1 });
    }
    expect(Object.keys(useVariableStore.getState().values)).toEqual(['PLC:A', 'PLC:B', 'PLC:C']);

    setVarMeta({ 'PLC:D': INTEGER });
    expect(Object.keys(useVariableStore.getState().values)).toEqual(['PLC:B', 'PLC:C']);
  });

  it('keeps the same values map when a metadata frame drops nothing', () => {
    const { applyBatch, setVarMeta } = useVariableStore.getState();
    setVarMeta({ 'PLC:A': INTEGER });
    applyBatch({ 'PLC:A': 1 });
    const before = useVariableStore.getState().values;

    setVarMeta({ 'PLC:A': INTEGER });
    expect(useVariableStore.getState().values).toBe(before);
  });

  it('keeps the object of every metadata entry a frame repeats unchanged', () => {
    const { setVarMeta } = useVariableStore.getState();
    const frame = { 'PLC:A': { ...INTEGER, min: 0 }, 'PLC:B': INTEGER };
    setVarMeta(frame);
    const before = useVariableStore.getState().varMeta;

    // Every frame arrives as fresh JSON.
    setVarMeta(structuredClone({ ...frame, 'PLC:B': { ...INTEGER, max: 9 } }));
    const changed = useVariableStore.getState().varMeta;
    expect(changed['PLC:A']).toBe(before['PLC:A']);
    expect(changed['PLC:B']).toEqual({ ...INTEGER, max: 9 });

    setVarMeta(structuredClone(changed));
    expect(useVariableStore.getState().varMeta).toBe(changed);
  });

  it('keeps local inputs however many metadata frames go by', () => {
    const input = localInputKey('frame', 'slot');
    useVariableStore.getState().applyBatch({ [input]: 7, 'PLC:A': 1 });
    for (const page of ['B', 'C', 'D', 'E']) {
      useVariableStore.getState().setVarMeta({ [`PLC:${page}`]: INTEGER });
    }
    expect(useVariableStore.getState().values).toEqual({ [input]: 7 });
  });

  it('starts the kept frames over on a reconnect', () => {
    const { applyBatch, setVarMeta, setWsConnected } = useVariableStore.getState();
    setVarMeta({ 'PLC:A': INTEGER });
    setVarMeta({ 'PLC:B': INTEGER });
    setWsConnected(true);
    applyBatch({ 'PLC:A': 1, 'PLC:B': 2 });

    // The previous connection's frames no longer count towards the three.
    setVarMeta({ 'PLC:C': INTEGER });
    expect(useVariableStore.getState().values).toEqual({});
  });

  it('resets connection-scoped readiness when a new WebSocket opens', () => {
    useVariableStore.setState({
      values: { 'OldPLC:Stale': 1 },
      varMeta: {
        'OldPLC:Stale': { type: { kind: 'scalar', base: 'Integer', array: false } },
      },
      metadataReceived: true,
      snapshotReceived: true,
      contextReadyPageIds: ['main'],
      opcuaConnected: { OldPLC: true },
    });

    useVariableStore.getState().setWsConnected(true);

    expect(useVariableStore.getState()).toMatchObject({
      wsConnected: true,
      values: {},
      varMeta: {},
      prevVarMeta: {},
      metadataReceived: false,
      snapshotReceived: false,
      contextReadyPageIds: [],
      opcuaConnected: {},
    });
  });

  it('records receipt of an authoritative empty metadata snapshot', () => {
    useVariableStore.getState().setVarMeta({});
    expect(useVariableStore.getState().metadataReceived).toBe(true);
  });
});
