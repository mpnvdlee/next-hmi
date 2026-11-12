import {
  bitKeyLabel,
  elementNameAt,
  flattenForRender,
  resolveElementBinding,
  rowSelectionKey,
  splitBitKey,
  typeFilter,
  type DatasourceNode,
  type RowItem,
} from './variableTreeHelpers';
import type {
  PickerFolderEntry,
  PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';

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

function arrayOfStructFolder(elementNamer: (i: number) => string, length = 2): PickerFolderEntry {
  return {
    kind: 'folder',
    name: 'Motors',
    is_array: true,
    _datasource: 'MyPLC',
    _path: 'Motors',
    children: Array.from({ length }, (_, i): PickerFolderEntry => ({
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

describe('resolveElementBinding', () => {
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

  // `index` is a position from 0 whatever the PLC counts from, as the runtime
  // and the backend's `_element_paths` read it: `[1]` of `ARRAY[1..12]` is 0.
  it.each([
    ['0', (i: number) => `[${i}]`],
    ['1', (i: number) => `[${i + 1}]`],
    ['1, "Prefix[N]" naming', (i: number) => `Line[${i + 1}]`],
  ])('binds each element of an array counting from %s by its position', (_from, namer) => {
    const arrayFolder = arrayOfStructFolder(namer, 12);
    const tree = dsTreeWith(arrayFolder);
    arrayFolder.children.forEach((child, position) => {
      const elem = child as PickerFolderEntry;
      expect(resolveElementBinding('MyPLC', elem._path!, elem, tree)).toEqual({
        path: 'Motors',
        index: position,
      });
    });
  });

  it('ranks elements by the number they end in, not by their order in the tree', () => {
    const arrayFolder = arrayOfStructFolder((i) => `[${i + 1}]`, 12);
    arrayFolder.children.reverse();
    const elem = arrayFolder.children.find((c) => (c as PickerFolderEntry).name === '[2]');
    const result = resolveElementBinding(
      'MyPLC',
      'Motors/[2]',
      elem as PickerFolderEntry,
      dsTreeWith(arrayFolder),
    );
    expect(result).toEqual({ path: 'Motors', index: 1 });
  });

  it('does not treat a plain struct folder as an array element even if it is bracket-named', () => {
    // A struct folder incidentally named "Line[2]" whose *parent* is not
    // flagged is_array must not be misread as an array element.
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

describe('elementNameAt', () => {
  const from0 = (i: number) => `[${i}]`;
  const from1 = (i: number) => `[${i + 1}]`;
  it.each([
    ['0', 0, '[0]', from0],
    ['0', 1, '[1]', from0],
    ['1', 0, '[1]', from1],
    ['1', 11, '[12]', from1],
    ['1, "Prefix[N]" naming', 1, 'Line[2]', (i: number) => `Line[${i + 1}]`],
  ])('on an array counting from %s, names position %i %s', (_from, position, name, namer) => {
    expect(elementNameAt(arrayOfStructFolder(namer, 12), position)).toBe(name);
  });

  // Past the end there is no element — not even on `ARRAY[1..10]`, whose
  // position 10 shares its number with the element `[10]` at position 9.
  it.each([
    ['0', 2, 5, from0],
    ['1', 10, 10, from1],
  ])(
    'names nothing past the end of an array counting from %s',
    (_from, length, position, namer) => {
      expect(elementNameAt(arrayOfStructFolder(namer, length), position)).toBeUndefined();
    },
  );
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

describe('typeFilter', () => {
  const leaf = (display_name: string, data_type: string, writable = true): PickerVariableEntry => ({
    kind: 'variable',
    display_name,
    data_type,
    enabled: true,
    writable,
  });
  const folder = (
    name: string,
    children: (PickerFolderEntry | PickerVariableEntry)[],
  ): PickerFolderEntry => ({
    kind: 'folder',
    name,
    children,
  });
  const names = (nodes: (PickerFolderEntry | PickerVariableEntry)[]) =>
    nodes.map((n) => ('display_name' in n ? n.display_name : `${n.name}/`));

  it('keeps an Integer variable out of a Float field', () => {
    const tree = [leaf('Speed', 'Float'), leaf('Count', 'Integer'), leaf('Run', 'Boolean')];
    expect(names(typeFilter(tree, { type: 'Float' }))).toEqual(['Speed']);
  });

  it('lists no variable of unknown access for a writing field', () => {
    const unknown = { ...leaf('Setpoint', 'Float'), writable: undefined };
    const tree = [leaf('Speed', 'Float'), unknown, leaf('SpeedRO', 'Float', false)];
    expect(names(typeFilter(tree, { type: 'Float', write: true }))).toEqual(['Speed']);
    expect(names(typeFilter(tree, { type: 'Float' }))).toEqual(['Speed', 'Setpoint', 'SpeedRO']);
  });

  it('binds a colour field to String variables only', () => {
    const tree = [leaf('Label', 'String'), leaf('Speed', 'Float')];
    expect(names(typeFilter(tree, { type: 'Color' }))).toEqual(['Label']);
  });

  it('reads a struct array counting from 1 off its lowest element', () => {
    const lines: PickerFolderEntry = {
      ...folder('Lines', [
        folder('Line[2]', [leaf('Speed', 'Float', false)]),
        folder('Line[1]', [leaf('Speed', 'Float')]),
      ]),
      is_array: true,
    };
    const selectable = (requiredFields: RequiredFieldEntry[]) =>
      (typeFilter([lines], { type: 'Motor[]', requiredFields })[0] as PickerFolderEntry | undefined)
        ?.selectable === true;
    expect(selectable([{ name: 'Speed', write: true }])).toBe(true);
    expect(selectable([{ name: 'Speed', type: 'Boolean' }])).toBe(false);
  });

  it('offers a struct folder only when its members fit — as the drawer judges it', () => {
    const tree = [
      folder('Motor', [leaf('Speed', 'Float'), leaf('Name', 'String')]),
      folder('MotorRO', [leaf('Speed', 'Float', false), leaf('Name', 'String')]),
      folder('Mistyped', [leaf('Speed', 'String'), leaf('Name', 'String')]),
    ];
    const selectable = (requiredFields: RequiredFieldEntry[]) =>
      (typeFilter(tree, { type: 'Motor', requiredFields }) as PickerFolderEntry[])
        .filter((f) => f.selectable)
        .map((f) => f.name);
    expect(selectable(['Speed'])).toEqual(['Motor', 'MotorRO', 'Mistyped']);
    expect(selectable([{ name: 'Speed', type: 'Float' }])).toEqual(['Motor', 'MotorRO']);
    expect(selectable([{ name: 'Speed', write: true }])).toEqual(['Motor', 'Mistyped']);
  });
});

describe('bits', () => {
  const status: PickerVariableEntry = {
    kind: 'variable',
    display_name: 'Status',
    data_type: 'Integer',
    bits: 16,
    enabled: true,
    writable: true,
    _datasource: 'Plant',
    _path: 'Battery/Status',
  };
  const ds: DatasourceNode = {
    kind: 'datasource',
    name: 'Plant',
    type: 'static',
    children: [status],
  };
  const boolField = { type: 'Boolean', write: true };

  it('keeps a whole number where its bits fit, only with Bits on', () => {
    expect(typeFilter([status], boolField)).toEqual([]);
    expect(typeFilter([status], boolField, true)).toEqual([status]);
    expect(typeFilter([{ ...status, writable: false }], boolField, true)).toEqual([]);
  });

  it("lists a word's bits only once its row is opened", () => {
    const closed = flattenForRender([ds], 0, new Set(), false, true);
    expect(closed.map(rowSelectionKey)).toEqual([null, 'Plant:Battery/Status']);
    const open = flattenForRender([ds], 0, new Set(['Plant:Battery/Status.%X']), false, true);
    expect(open).toHaveLength(18);
    const bit5 = rowSelectionKey(open[7])!;
    expect(bit5).toBe('Plant:Battery/Status.%X5');
    expect(splitBitKey('Battery/Status.%X5')).toEqual({ path: 'Battery/Status', bit: 5 });
    expect(bitKeyLabel('Status.%X5')).toBe('Status.5');
  });
});
