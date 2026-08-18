import { describe, expect, it } from 'vitest';
import { safeSignInTarget } from './sessionStore';

describe('safeSignInTarget', () => {
  it('accepts project-instance paths', () => {
    expect(safeSignInTarget('/editor/plant-a/config')).toBe('/editor/plant-a/config');
    expect(safeSignInTarget('/runtime/plant-a/pages/1?x=2')).toBe('/runtime/plant-a/pages/1?x=2');
  });

  it.each([
    null,
    '',
    '/projects',
    '/api/manager/running',
    '//evil.example/',
    'https://evil.example/',
    '/editor/a/\r\nx',
    '/\\evil.example',
  ])('rejects %j', (raw) => {
    expect(safeSignInTarget(raw)).toBeNull();
  });
});
