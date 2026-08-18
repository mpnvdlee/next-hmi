import { describe, it, expect } from 'vitest';
import { BUILTIN_ICON_IDS } from './iconAllowlist';
import builtinIconIdsFixture from '../types/__fixtures__/builtinIconIds.json';

describe('BUILTIN_ICON_IDS', () => {
  it('matches the shared fixture also read by backend/core/validation/structure.py', () => {
    expect(new Set(builtinIconIdsFixture as string[])).toEqual(BUILTIN_ICON_IDS);
  });
});
