import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useVariableStore } from '@hmi/store/variableStore';
import type { VarMeta } from '@hmi/store/variableStore';
import { setRepeatsChildren } from '@shared/utils/parentFlow';
import RepeatEditorScopeProvider from './RepeatEditorScopeProvider';
import { useRepeatEditorScope, type RepeatEditorScope } from './repeatScopeContext';

const float = { kind: 'scalar', base: 'Float', array: false } as const;

function scopeFor(arrayKey: string, varMeta: Record<string, VarMeta>): RepeatEditorScope | null {
  return scopeForItems({ $var: { path: arrayKey } }, varMeta);
}

function scopeForItems(
  items: unknown,
  varMeta: Record<string, VarMeta> = {},
): RepeatEditorScope | null {
  // Unmount first: a store update must not re-render an earlier probe.
  cleanup();
  setRepeatsChildren('Repeater', 'items');
  useVariableStore.setState({ varMeta });
  let seen: RepeatEditorScope | null = null;
  function Probe() {
    seen = useRepeatEditorScope();
    return null;
  }
  const roots = [
    {
      id: 'rep',
      type: 'Repeater',
      properties: { items },
      children: [{ id: 'child', type: 'Label' }],
    },
  ];
  render(
    <RepeatEditorScopeProvider roots={roots} widgetId="child">
      <Probe />
    </RepeatEditorScopeProvider>,
  );
  return seen;
}

afterEach(() => {
  cleanup();
  useVariableStore.setState({ varMeta: {} });
  setRepeatsChildren('Repeater', null);
});

describe('RepeatEditorScopeProvider', () => {
  it("records each member's type and access off the lowest element, nested structs included", () => {
    const scope = scopeFor('PLC:Motors', {
      'PLC:Motors': {
        type: { kind: 'struct', name: 'Motors', array: true, fields: ['Speed', 'Io'] },
      },
      'PLC:Motors/Line[2]/Speed': { type: float, writable: true },
      'PLC:Motors/Line[1]/Speed': { type: float, writable: false },
      'PLC:Motors/Line[1]/Io': {
        type: { kind: 'struct', name: 'Io', array: false, fields: ['On'] },
      },
      'PLC:Motors/Line[1]/Io/On': {
        type: { kind: 'scalar', base: 'Boolean', array: false },
        writable: true,
      },
    });
    expect(scope?.memberInfo).toEqual({
      Speed: { type: float, writable: false },
      Io: { type: { kind: 'struct', name: 'Io', array: false, fields: ['On'] } },
      'Io/On': { type: { kind: 'scalar', base: 'Boolean', array: false }, writable: true },
    });
  });

  it("gives a scalar element the array variable's own access", () => {
    const setpoints = { type: { ...float, array: true } };
    expect(scopeFor('PLC:Set', { 'PLC:Set': { ...setpoints, writable: false } })?.writable).toBe(
      false,
    );
    expect(scopeFor('PLC:Set', { 'PLC:Set': { ...setpoints, writable: true } })?.writable).toBe(
      true,
    );
    expect(scopeFor('PLC:Set', { 'PLC:Set': setpoints })?.writable).toBe(false);
  });

  it('types a literal list of records by its values, and never writes it', () => {
    const records = [
      { label: 'Low', value: 1, on: true },
      { label: 'High', value: 2.5, on: 'yes' },
    ];
    const expected = {
      members: ['label', 'value', 'on'],
      writable: false,
      elementType: 'Struct',
      memberTypes: { label: 'String', value: 'Float' },
    };
    expect(scopeForItems(records)).toEqual(expected);
    expect(scopeForItems({ $static: records })).toEqual(expected);
  });

  it('types a literal list of scalars, and leaves a mixed one unknown', () => {
    expect(scopeForItems([1, 2, 3])).toEqual({
      members: [],
      writable: false,
      elementType: 'Integer',
    });
    expect(scopeForItems([1, 'a'])).toEqual({ members: null, writable: false });
  });

  it('leaves a list of records with no keys unknown, as the validator does', () => {
    expect(scopeForItems([{}])).toEqual({ members: null, writable: false });
  });

  it("offers the list editor's label and value members on an empty list, untyped", () => {
    expect(scopeForItems([])).toEqual({
      members: ['label', 'value'],
      writable: false,
      elementType: 'Struct',
    });
  });

  it('gives a user list label and value strings', () => {
    expect(scopeForItems({ $user: { field: 'userList' } })?.memberTypes).toEqual({
      label: 'String',
      value: 'String',
    });
  });
});
