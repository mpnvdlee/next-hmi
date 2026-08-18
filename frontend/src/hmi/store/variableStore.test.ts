import { useVariableStore } from './variableStore';

describe('variableStore', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: {},
      varMeta: {},
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
    });

    useVariableStore.getState().removeVars(['MyPLC:Motor/Speed', 'MyPLC:Motor/HMI']);

    const state = useVariableStore.getState();
    expect(state.values).toEqual({});
    expect(state.varMeta).toEqual({});
  });

  it('replaces a snapshot generation instead of retaining old cached values', () => {
    useVariableStore.setState({ values: { 'OldPLC:Stale': 1 } });
    useVariableStore.getState().replaceValues({ 'NewPLC:Fresh': 2 });

    expect(useVariableStore.getState().values).toEqual({ 'NewPLC:Fresh': 2 });
  });

  it('treats metadata as authoritative and prunes values for removed keys', () => {
    useVariableStore.setState({
      values: { 'PLC:Keep': 1, 'PLC:Remove': 2 },
      varMeta: {
        'PLC:Keep': { type: { kind: 'scalar', base: 'Integer', array: false } },
        'PLC:Remove': { type: { kind: 'scalar', base: 'Integer', array: false } },
      },
    });

    useVariableStore.getState().setVarMeta({
      'PLC:Keep': { type: { kind: 'scalar', base: 'Integer', array: false } },
    });

    expect(useVariableStore.getState().values).toEqual({ 'PLC:Keep': 1 });
    expect(Object.keys(useVariableStore.getState().varMeta)).toEqual(['PLC:Keep']);
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
