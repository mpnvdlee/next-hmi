import { afterEach, describe, it, expect } from 'vitest';
import { BUILTIN_ICON_ALLOWLIST } from '@shared/config/iconAllowlist';
import { isBuiltinIconId, getBuiltinIconComponent, isCustomIconAssetPath } from './phosphorIcons';

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

describe('isCustomIconAssetPath', () => {
  afterEach(() => {
    delete window.__NEXTHMI_BASE__;
  });

  it('accepts an .svg file inside the icons folder', () => {
    expect(isCustomIconAssetPath('/assets/icons/pump.svg')).toBe(true);
    expect(isCustomIconAssetPath('/assets/icons/valves/gate valve.SVG')).toBe(true);
    expect(isCustomIconAssetPath('/assets/icons/caf%C3%A9.svg')).toBe(true);
  });

  it('accepts the logical and the base-prefixed form under a proxied base', () => {
    window.__NEXTHMI_BASE__ = '/runtime/demo/';
    expect(isCustomIconAssetPath('/assets/icons/pump.svg')).toBe(true);
    expect(isCustomIconAssetPath('/runtime/demo/assets/icons/pump.svg')).toBe(true);
    expect(isCustomIconAssetPath('/runtime/other/assets/icons/pump.svg')).toBe(false);
  });

  it('rejects the historian echo that reached markup through ../', () => {
    expect(
      isCustomIconAssetPath(
        '/assets/icons/../../api/historian/query?start=-1h&variables=%3Csvg%3E%3Cimg%20src=x%20onerror=alert(1)%3E%3C/svg%3E',
      ),
    ).toBe(false);
    window.__NEXTHMI_BASE__ = '/runtime/demo/';
    expect(isCustomIconAssetPath('/runtime/demo/assets/icons/../../api/x.svg')).toBe(false);
  });

  it.each([
    ['a parent segment', '/assets/icons/../../api/x.svg'],
    ['a dot segment', '/assets/icons/./x.svg'],
    ['an encoded parent segment', '/assets/icons/%2e%2e/%2E%2E/api/x.svg'],
    ['a half-encoded parent segment', '/assets/icons/.%2e/x.svg'],
    ['an encoded slash', '/assets/icons/..%2f..%2fapi%2fx.svg'],
    ['an encoded backslash', '/assets/icons/..%5c..%5capi%5cx.svg'],
    ['a backslash', '/assets/icons/..\\..\\api\\x.svg'],
    ['a query', '/assets/icons/x.svg?v=1'],
    ['an empty query', '/assets/icons/x.svg?'],
    ['a hash', '/assets/icons/x.svg#frag'],
    ['a malformed escape', '/assets/icons/%E0%A4%A.svg'],
    ['a double quote', '/assets/icons/x".svg'],
    ['a newline', '/assets/icons/x\n.svg'],
    ['another origin', 'https://evil.example/assets/icons/x.svg'],
    ['a protocol-relative URL', '//evil.example/assets/icons/x.svg'],
    ['a javascript: URL', 'javascript:alert(1)//assets/icons/x.svg'],
    ['a relative path', 'assets/icons/x.svg'],
    ['a file outside the icons folder', '/assets/images/x.svg'],
    ['a prefix look-alike', '/assets/icons-evil/x.svg'],
    ['a file that is not an svg', '/assets/icons/x.png'],
    ['an API path', '/api/historian/query'],
  ])('rejects %s', (_label, value) => {
    expect(isCustomIconAssetPath(value)).toBe(false);
  });
});
