import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import { mixedLayoutMap, multiLayoutValueOf, multiValueOf } from './multiValue';

const widget = (
  id: string,
  properties: Record<string, unknown> = {},
  layout: Partial<LayoutConfig> = {},
): WidgetConfig => ({ id, type: 'Button', name: id, properties, layout });

describe('multiValueOf', () => {
  it('reports a shared literal', () => {
    expect(
      multiValueOf([widget('a', { label: 'Go' }), widget('b', { label: 'Go' })], 'label'),
    ).toEqual({ state: 'same', value: 'Go' });
  });

  it('reports a shared value that is unset everywhere', () => {
    expect(multiValueOf([widget('a'), widget('b')], 'label')).toEqual({
      state: 'same',
      value: undefined,
    });
  });

  it('compares sourced values structurally', () => {
    const binding = { $var: { path: 'ds:tag' } };
    expect(
      multiValueOf(
        [widget('a', { label: binding }), widget('b', { label: { ...binding } })],
        'label',
      ),
    ).toEqual({ state: 'same', value: binding });
  });

  it('keeps the shared source when only the values differ', () => {
    expect(
      multiValueOf(
        [
          widget('a', { label: { $var: { path: 'ds:one' } } }),
          widget('b', { label: { $var: { path: 'ds:two' } } }),
        ],
        'label',
      ),
    ).toEqual({ state: 'mixed', source: '$var' });
  });

  it('drops the source when the widgets disagree on it too', () => {
    expect(
      multiValueOf(
        [widget('a', { label: 'Go' }), widget('b', { label: { $var: { path: 'ds:tag' } } })],
        'label',
      ),
    ).toEqual({ state: 'mixed', source: null });
  });

  it('treats unset and an explicit value as mixed, still sharing the static source', () => {
    expect(multiValueOf([widget('a'), widget('b', { label: 'Go' })], 'label')).toEqual({
      state: 'mixed',
      source: 'static',
    });
  });
});

describe('multiLayoutValueOf', () => {
  it('reads through to the layout object', () => {
    expect(
      multiLayoutValueOf([widget('a', {}, { grow: 1 }), widget('b', {}, { grow: 1 })], 'grow'),
    ).toEqual({ state: 'same', value: 1 });
  });
});

describe('mixedLayoutMap', () => {
  it('lists only the keys that differ, with the source they share', () => {
    const map = mixedLayoutMap([
      widget('a', {}, { grow: 1, width: '10px' }),
      widget('b', {}, { grow: 1, width: '20px' }),
    ]);

    expect([...map.keys()]).toEqual(['width']);
    expect(map.get('width')).toBe('static');
  });

  it('counts a key only one widget sets as mixed', () => {
    const map = mixedLayoutMap([widget('a', {}, { width: '10px' }), widget('b')]);

    expect([...map.keys()]).toEqual(['width']);
  });

  it('is empty when no widget sets any layout', () => {
    expect(mixedLayoutMap([widget('a'), widget('b')]).size).toBe(0);
  });
});
