import { describe, expect, it } from 'vitest';

import { usesFlexLayout } from './parentFlow';

describe('usesFlexLayout', () => {
  it('reads the built-in Container’s flowsChildren declaration', () => {
    expect(usesFlexLayout('Container')).toBe(true);
  });

  it('says no to a host that pins its children, and to a leaf', () => {
    expect(usesFlexLayout('ImageContainer')).toBe(false);
    expect(usesFlexLayout('Label')).toBe(false);
    expect(usesFlexLayout('$component:card')).toBe(false);
  });
});
