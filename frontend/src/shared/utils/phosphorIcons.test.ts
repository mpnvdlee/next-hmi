import { describe, it, expect } from 'vitest';
import { BUILTIN_ICON_ALLOWLIST } from '@shared/config/iconAllowlist';
import { isBuiltinIconId, getBuiltinIconComponent } from './phosphorIcons';

describe('picker/runtime icon parity', () => {
  it('resolves a runtime component for every allowlisted picker icon', () => {
    for (const { id } of BUILTIN_ICON_ALLOWLIST) {
      expect(isBuiltinIconId(id)).toBe(true);
      expect(getBuiltinIconComponent(id)).not.toBeNull();
    }
  });

  it('exposes the newly authorable columns and cube icons', () => {
    expect(isBuiltinIconId('columns')).toBe(true);
    expect(isBuiltinIconId('cube')).toBe(true);
  });

  it('rejects an unknown icon id', () => {
    expect(isBuiltinIconId('not-a-real-icon')).toBe(false);
    expect(getBuiltinIconComponent('not-a-real-icon')).toBeNull();
  });
});
