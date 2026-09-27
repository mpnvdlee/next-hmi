import {
  NUMERIC_SLOT,
  schemaFieldPicker,
  slotFilter,
  wrapPicker,
  type OpenBindingPicker,
} from './utils';

describe('wrapPicker slot', () => {
  it("passes the wrapped slot's own type to the parent", () => {
    const parent = vi.fn<OpenBindingPicker>();
    wrapPicker(parent, vi.fn(), undefined, true)!();
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, true, undefined);
  });

  it('lets a deeper slot’s type through an outer wrap that sets none', () => {
    const parent = vi.fn<OpenBindingPicker>();
    const outer = wrapPicker(parent, vi.fn())!;
    const inner = wrapPicker(outer, vi.fn(), undefined, true)!;
    inner();
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, true, undefined);
  });

  it('lets the innermost slot that names a type win', () => {
    const parent = vi.fn<OpenBindingPicker>();
    const condition = wrapPicker(parent, vi.fn(), undefined, true)!;
    const operand = wrapPicker(condition, vi.fn(), undefined, NUMERIC_SLOT)!;
    operand();
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, NUMERIC_SLOT, undefined);
  });

  it("hands the slot's Repeat item option through untouched", () => {
    const parent = vi.fn<OpenBindingPicker>();
    const extras = { repeatItem: { scope: { members: [], writable: true }, onPick: vi.fn() } };
    wrapPicker(wrapPicker(parent, vi.fn()), vi.fn())!(undefined, undefined, undefined, extras);
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, undefined, extras);
  });
});

describe('slotFilter', () => {
  const filter = { label: 'Value', type: 'String', write: true };

  it('keeps the full filter for a typed slot', () => {
    expect(slotFilter(filter)).toBe(filter);
  });

  it('keeps only the label for a slot that takes any type', () => {
    expect(slotFilter(filter, true)).toEqual({ label: 'Value' });
  });

  it("puts a typed slot's own type under the property's label, read-only", () => {
    expect(slotFilter(filter, NUMERIC_SLOT)).toEqual({
      label: 'Value',
      type: ['Float', 'Integer'],
    });
  });
});

describe('schemaFieldPicker', () => {
  const schema = {
    type: 'Motor',
    label: 'Motor',
    write: true,
    requiredFields: [{ name: 'Speed', type: 'Float' }],
  };

  it('opens the drawer filtered to the field, writing a top-level pick itself', () => {
    const open = vi.fn();
    const write = vi.fn();
    schemaFieldPicker(open, schema, write)!();
    expect(open).toHaveBeenCalledWith('', 'Motor', {
      onPick: write,
      currentBinding: undefined,
      filter: {
        label: 'Motor',
        type: 'Motor',
        write: true,
        requiredFields: [{ name: 'Speed', type: 'Float' }],
      },
    });
  });

  it("lets a nested slot's own pick and type through", () => {
    const open = vi.fn();
    const nested = vi.fn();
    schemaFieldPicker(open, schema, vi.fn())!(nested, undefined, true);
    expect(open).toHaveBeenCalledWith(
      '',
      'Motor',
      expect.objectContaining({ onPick: nested, filter: { label: 'Motor' } }),
    );
  });

  it('offers no drawer for a field that binds no variable', () => {
    expect(schemaFieldPicker(vi.fn(), { type: 'actions', label: 'Actions' }, vi.fn())).toBe(
      undefined,
    );
  });
});
