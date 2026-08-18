import {
  resolveElementBinding,
  rowSelectionKey,
  type DatasourceNode,
  type RowItem,
} from './variableTreeHelpers';
import type {
  PickerFolderEntry,
  PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';

function scalarArrayVar(): PickerVariableEntry {
  return {
    kind: 'variable',
    display_name: 'MyArray',
    data_type: 'Float',
    enabled: true,
    is_array: true,
    _datasource: 'MyPLC',
    _path: 'MyArray',
  };
}

function arrayOfStructFolder(elementNamer: (i: number) => string): PickerFolderEntry {
  return {
    kind: 'folder',
    name: 'Motors',
    is_array: true,
    _datasource: 'MyPLC',
    _path: 'Motors',
    children: [0, 1].map((i): PickerFolderEntry => ({
      kind: 'folder',
      name: elementNamer(i),
      _datasource: 'MyPLC',
      _path: `Motors/${elementNamer(i)}`,
      children: [
        {
          kind: 'variable',
          display_name: 'Speed',
          data_type: 'Float',
          enabled: true,
          _datasource: 'MyPLC',
          _path: `Motors/${elementNamer(i)}/Speed`,
        } satisfies PickerVariableEntry,
      ],
    })),
  };
}

function dsTreeWith(...children: (PickerFolderEntry | PickerVariableEntry)[]): DatasourceNode[] {
  return [{ kind: 'datasource', name: 'MyPLC', type: 'opcua-client', children }];
}

describe('resolveElementBinding (§10.5)', () => {
  it('resolves a scalar-array element (no separator before the bracket)', () => {
    const result = resolveElementBinding('MyPLC', 'MyArray[2]', null, dsTreeWith(scalarArrayVar()));
    expect(result).toEqual({ path: 'MyArray', index: 2 });
  });

  it('leaves a plain scalar variable untouched', () => {
    const result = resolveElementBinding('MyPLC', 'MyArray', null, dsTreeWith(scalarArrayVar()));
    expect(result).toEqual({ path: 'MyArray' });
  });

  it('resolves a struct[] element folder with bare "[N]" naming', () => {
    const arrayFolder = arrayOfStructFolder((i) => `[${i}]`);
    const elemFolder = arrayFolder.children[1] as PickerFolderEntry;
    const result = resolveElementBinding(
      'MyPLC',
      'Motors/[1]',
      elemFolder,
      dsTreeWith(arrayFolder),
    );
    expect(result).toEqual({ path: 'Motors', index: 1 });
  });

  it('resolves a struct[] element folder with "Prefix[N]" naming (static-server style)', () => {
    const arrayFolder = arrayOfStructFolder((i) => `Line[${i}]`);
    const elemFolder = arrayFolder.children[0] as PickerFolderEntry;
    const result = resolveElementBinding(
      'MyPLC',
      'Motors/Line[0]',
      elemFolder,
      dsTreeWith(arrayFolder),
    );
    // Stripping just the last path segment ("Line[0]") must yield the real
    // array root ("Motors"), not a regex-mangled "Motors/Line".
    expect(result).toEqual({ path: 'Motors', index: 0 });
  });

  it('does not treat a plain struct folder as an array element even if it is bracket-named', () => {
    // A struct folder incidentally named "Line[2]" whose *parent* is not
    // flagged is_array must not be misread as an array element (§10.1).
    const plainFolder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Line[2]',
      _datasource: 'MyPLC',
      _path: 'Cabinet/Line[2]',
      children: [],
    };
    const cabinetFolder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Cabinet',
      _datasource: 'MyPLC',
      _path: 'Cabinet',
      children: [plainFolder],
    };
    const result = resolveElementBinding(
      'MyPLC',
      'Cabinet/Line[2]',
      plainFolder,
      dsTreeWith(cabinetFolder),
    );
    expect(result).toEqual({ path: 'Cabinet/Line[2]' });
  });

  it('leaves a plain (non-indexed) folder untouched', () => {
    const folder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Settings',
      _datasource: 'MyPLC',
      _path: 'Settings',
      children: [],
    };
    const result = resolveElementBinding('MyPLC', 'Settings', folder, dsTreeWith(folder));
    expect(result).toEqual({ path: 'Settings' });
  });
});

describe('rowSelectionKey', () => {
  it('keys a nested variable by "datasource:path" (matches the stored binding path)', () => {
    // The bug: a valueDisplay bound to LegacyPLC:Pump1/Pressure did not scroll
    // into view because nothing located its row. Its key must equal the
    // currentKey the picker derives from the $var binding.
    const entry: PickerVariableEntry = {
      kind: 'variable',
      display_name: 'Pressure',
      data_type: 'Float',
      enabled: true,
      writable: false,
      _datasource: 'LegacyPLC',
      _path: 'Pump1/Pressure',
    };
    const item: RowItem = { kind: 'variable', entry, depth: 2 };
    expect(rowSelectionKey(item)).toBe('LegacyPLC:Pump1/Pressure');
  });

  it('keys a scalar-array element with a bracket suffix on the parent path', () => {
    const item: RowItem = {
      kind: 'array-element',
      parent: scalarArrayVar(),
      index: 2,
      depth: 2,
      path: 'MyArray',
    };
    expect(rowSelectionKey(item)).toBe('MyPLC:MyArray[2]');
  });

  it('keys a selectable folder but returns null for a plain (browse-only) folder', () => {
    const base: PickerFolderEntry = {
      kind: 'folder',
      name: 'Motors',
      _datasource: 'MyPLC',
      _path: 'Motors',
      children: [],
    };
    expect(
      rowSelectionKey({ kind: 'folder', folder: { ...base, selectable: true }, depth: 1 }),
    ).toBe('MyPLC:Motors');
    expect(rowSelectionKey({ kind: 'folder', folder: base, depth: 1 })).toBeNull();
  });

  it('returns null for a datasource header row', () => {
    const item: RowItem = { kind: 'datasource', node: dsTreeWith()[0], depth: 0 };
    expect(rowSelectionKey(item)).toBeNull();
  });
});
