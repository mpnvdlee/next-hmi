import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  editorPath,
  getBasePath,
  getMode,
  isInsecureOrigin,
  routerBasename,
  stripBase,
  withBase,
  wsUrl,
} from './runtimeBase';

function setRuntime(base: string | undefined, mode?: string) {
  if (base === undefined) delete (window as { __NEXTHMI_BASE__?: string }).__NEXTHMI_BASE__;
  else (window as { __NEXTHMI_BASE__?: string }).__NEXTHMI_BASE__ = base;
  if (mode === undefined) delete (window as { __NEXTHMI_MODE__?: string }).__NEXTHMI_MODE__;
  else (window as { __NEXTHMI_MODE__?: string }).__NEXTHMI_MODE__ = mode;
}

afterEach(() => {
  setRuntime(undefined, undefined);
  vi.unstubAllGlobals();
});

describe('runtimeBase defaults (dev / no injection)', () => {
  it('defaults to root + instance', () => {
    expect(getBasePath()).toBe('/');
    expect(getMode()).toBe('instance');
    expect(routerBasename()).toBe('');
  });

  it('leaves paths untouched at root', () => {
    expect(withBase('/api/x')).toBe('/api/x');
    expect(stripBase('/api/x')).toBe('/api/x');
  });

  it('uses the legacy config prefix for editor paths', () => {
    expect(editorPath('/editor')).toBe('/config/editor');
  });
});

describe('editor area', () => {
  it('builds root-relative editor paths inside an editor project base', () => {
    setRuntime('/editor/demo/', 'instance');
    expect(editorPath('/editor')).toBe('/editor');
    expect(editorPath('/datasources')).toBe('/datasources');
  });
});

describe('instance prefix', () => {
  it('reads base + computes router basename', () => {
    setRuntime('/runtime/abc/', 'instance');
    expect(getBasePath()).toBe('/runtime/abc/');
    expect(routerBasename()).toBe('/runtime/abc');
    expect(getMode()).toBe('instance');
  });

  it('prefixes root-relative paths and is idempotent', () => {
    setRuntime('/runtime/abc/', 'instance');
    expect(withBase('/api/config')).toBe('/runtime/abc/api/config');
    expect(withBase('/runtime/abc/api/config')).toBe('/runtime/abc/api/config');
    expect(withBase('https://x/y')).toBe('https://x/y');
  });

  it('strips the prefix back to the logical path', () => {
    setRuntime('/runtime/abc/', 'instance');
    expect(stripBase('/runtime/abc/assets/icons/x.svg')).toBe('/assets/icons/x.svg');
    expect(stripBase('/assets/icons/x.svg')).toBe('/assets/icons/x.svg');
  });

  it('builds a prefixed ws url', () => {
    setRuntime('/runtime/abc/', 'instance');
    expect(wsUrl()).toBe(`ws://${window.location.host}/runtime/abc/ws`);
  });
});

describe('manager mode', () => {
  it('reports manager mode at root', () => {
    setRuntime('/', 'manager');
    expect(getMode()).toBe('manager');
    expect(routerBasename()).toBe('');
  });
});

describe('insecure origin', () => {
  it('stays quiet on a secure context — HTTPS, or loopback over plain HTTP', () => {
    vi.stubGlobal('isSecureContext', true);
    expect(isInsecureOrigin()).toBe(false);
  });

  it('reports plain HTTP on a network address', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(isInsecureOrigin()).toBe(true);
  });

  // Stubbed rather than left to jsdom's silence: jsdom happens not to implement
  // the property, but one that started to would report `true` for its
  // `http://localhost/` default and this would pass for the wrong reason.
  it('reports nothing where the browser states no verdict', () => {
    vi.stubGlobal('isSecureContext', undefined);

    expect(window.isSecureContext).toBeUndefined();
    expect(isInsecureOrigin()).toBe(false);
  });
});
