import { slotFilter, wrapPicker, type OpenBindingPicker } from './utils';

describe('wrapPicker anyType', () => {
  it("passes the wrapped slot's own anyType to the parent", () => {
    const parent = vi.fn<OpenBindingPicker>();
    wrapPicker(parent, vi.fn(), undefined, true)!();
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, true);
  });

  it('lets a deeper slot’s anyType through an outer wrap that sets none', () => {
    const parent = vi.fn<OpenBindingPicker>();
    const outer = wrapPicker(parent, vi.fn())!;
    const inner = wrapPicker(outer, vi.fn(), undefined, true)!;
    inner();
    expect(parent).toHaveBeenCalledWith(expect.any(Function), undefined, true);
  });
});

describe('slotFilter', () => {
  const filter = { label: 'Value', type: 'String', write: true };

  it('keeps the full filter for a typed slot', () => {
    expect(slotFilter(filter)).toBe(filter);
  });

  it('keeps only the label for an anyType slot', () => {
    expect(slotFilter(filter, true)).toEqual({ label: 'Value' });
  });
});
