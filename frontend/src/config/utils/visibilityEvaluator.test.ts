import { evaluateVisibility } from './visibilityEvaluator';

describe('evaluateVisibility', () => {
  describe('no condition (always visible)', () => {
    it('returns true when visibleWhen is undefined', () => {
      expect(evaluateVisibility(undefined, {})).toBe(true);
    });

    it('returns true when visibleWhen is undefined regardless of properties', () => {
      expect(evaluateVisibility(undefined, { mode: 'read' })).toBe(true);
    });
  });

  describe('single condition: equals', () => {
    it('returns true when property matches equals value', () => {
      expect(
        evaluateVisibility({ property: 'mode', equals: 'advanced' }, { mode: 'advanced' }),
      ).toBe(true);
    });

    it('returns false when property does not match equals value', () => {
      expect(evaluateVisibility({ property: 'mode', equals: 'advanced' }, { mode: 'basic' })).toBe(
        false,
      );
    });

    it('returns false when property is absent (undefined !== equals value)', () => {
      expect(evaluateVisibility({ property: 'mode', equals: 'advanced' }, {})).toBe(false);
    });

    it('uses strict equality (number vs string)', () => {
      expect(evaluateVisibility({ property: 'count', equals: 1 }, { count: '1' })).toBe(false);
      expect(evaluateVisibility({ property: 'count', equals: 1 }, { count: 1 })).toBe(true);
    });

    it('handles boolean equals values', () => {
      expect(evaluateVisibility({ property: 'enabled', equals: true }, { enabled: true })).toBe(
        true,
      );
      expect(evaluateVisibility({ property: 'enabled', equals: true }, { enabled: false })).toBe(
        false,
      );
    });
  });

  describe('single condition: notEquals', () => {
    it('returns true when property does not match notEquals value', () => {
      expect(
        evaluateVisibility({ property: 'mode', notEquals: 'disabled' }, { mode: 'enabled' }),
      ).toBe(true);
    });

    it('returns false when property matches notEquals value', () => {
      expect(
        evaluateVisibility({ property: 'mode', notEquals: 'disabled' }, { mode: 'disabled' }),
      ).toBe(false);
    });

    it('returns true when property is absent (undefined !== notEquals value)', () => {
      expect(evaluateVisibility({ property: 'mode', notEquals: 'disabled' }, {})).toBe(true);
    });
  });

  describe('single condition: neither equals nor notEquals', () => {
    it('returns true as default', () => {
      expect(evaluateVisibility({ property: 'mode' }, {})).toBe(true);
      expect(evaluateVisibility({ property: 'mode' }, { mode: 'anything' })).toBe(true);
    });
  });

  describe('array of conditions (AND logic)', () => {
    it('returns true when empty array', () => {
      expect(evaluateVisibility([], {})).toBe(true);
    });

    it('returns true when all conditions pass', () => {
      expect(
        evaluateVisibility(
          [
            { property: 'mode', equals: 'advanced' },
            { property: 'enabled', equals: true },
          ],
          { mode: 'advanced', enabled: true },
        ),
      ).toBe(true);
    });

    it('returns false when first condition fails', () => {
      expect(
        evaluateVisibility(
          [
            { property: 'mode', equals: 'advanced' },
            { property: 'enabled', equals: true },
          ],
          { mode: 'basic', enabled: true },
        ),
      ).toBe(false);
    });

    it('returns false when second condition fails', () => {
      expect(
        evaluateVisibility(
          [
            { property: 'mode', equals: 'advanced' },
            { property: 'enabled', equals: true },
          ],
          { mode: 'advanced', enabled: false },
        ),
      ).toBe(false);
    });

    it('returns false when all conditions fail', () => {
      expect(
        evaluateVisibility(
          [
            { property: 'mode', equals: 'advanced' },
            { property: 'enabled', notEquals: 'disabled' },
          ],
          { mode: 'basic', enabled: 'disabled' },
        ),
      ).toBe(false);
    });

    it('mixes equals and notEquals conditions', () => {
      expect(
        evaluateVisibility(
          [
            { property: 'type', equals: 'gauge' },
            { property: 'mode', notEquals: 'hidden' },
          ],
          { type: 'gauge', mode: 'visible' },
        ),
      ).toBe(true);
    });
  });
});
