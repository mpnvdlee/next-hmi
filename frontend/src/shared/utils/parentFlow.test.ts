import { describe, expect, it } from 'vitest';

import { repeatItemsKey, setRepeatsChildren, usesFlexLayout } from './parentFlow';

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

describe('repeatItemsKey', () => {
  it('reads the built-in Repeater off the manifest', () => {
    expect(repeatItemsKey('Repeater')).toBe('items');
    expect(repeatItemsKey('Container')).toBeNull();
  });

  it('follows a project widget declaring (and dropping) repeatsChildren', () => {
    setRepeatsChildren('Carousel', 'slides');
    expect(repeatItemsKey('Carousel')).toBe('slides');
    setRepeatsChildren('Carousel', null);
    expect(repeatItemsKey('Carousel')).toBeNull();
  });
});
