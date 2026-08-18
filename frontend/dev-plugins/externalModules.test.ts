import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildImportMap,
  readOverrides,
  resolveLiveProjectDir,
  resolveRuntimeHome,
  scanExternalLibraries,
} from './externalModules';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexthmi-extmod-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

describe('scanExternalLibraries', () => {
  test('returns empty map when external-libraries dir does not exist', () => {
    expect(scanExternalLibraries(path.join(tmpRoot, 'missing'))).toEqual({});
  });

  test('returns empty map when external-libraries dir is empty', () => {
    fs.mkdirSync(path.join(tmpRoot, 'external-libraries'));
    expect(scanExternalLibraries(path.join(tmpRoot, 'external-libraries'))).toEqual({});
  });

  test('maps a loose .js file by its bare name', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    touch(path.join(extLibs, 'three.js'));
    expect(scanExternalLibraries(extLibs)).toEqual({ three: '/external-libraries/three.js' });
  });

  test('maps a loose .mjs file by its bare name', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    touch(path.join(extLibs, 'modern.mjs'));
    expect(scanExternalLibraries(extLibs)).toEqual({ modern: '/external-libraries/modern.mjs' });
  });

  test('folder with no same-name file maps only as a subpath root', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    fs.mkdirSync(path.join(extLibs, 'three'));
    touch(path.join(extLibs, 'three/examples/foo.js'));
    expect(scanExternalLibraries(extLibs)).toEqual({ 'three/': '/external-libraries/three/' });
  });

  test('external-libraries/<name>/<name>.js becomes the bare entry, folder is also exposed as subpath root', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    fs.mkdirSync(path.join(extLibs, 'three'));
    touch(path.join(extLibs, 'three/three.js'));
    touch(path.join(extLibs, 'three/examples/jsm/foo.js'));
    expect(scanExternalLibraries(extLibs)).toEqual({
      three: '/external-libraries/three/three.js',
      'three/': '/external-libraries/three/',
    });
  });

  test('external-libraries/<name>/<name>.mjs is also a valid bare entry', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    fs.mkdirSync(path.join(extLibs, 'modern'));
    touch(path.join(extLibs, 'modern/modern.mjs'));
    expect(scanExternalLibraries(extLibs)).toEqual({
      modern: '/external-libraries/modern/modern.mjs',
      'modern/': '/external-libraries/modern/',
    });
  });

  test('a loose root file and a folder of the same name coexist (bare + subpath)', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    touch(path.join(extLibs, 'three.js'));
    fs.mkdirSync(path.join(extLibs, 'three'));
    expect(scanExternalLibraries(extLibs)).toEqual({
      three: '/external-libraries/three.js',
      'three/': '/external-libraries/three/',
    });
  });

  test('skips dot- and underscore-prefixed entries', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    fs.mkdirSync(path.join(extLibs, '.hidden'));
    fs.mkdirSync(path.join(extLibs, '_private'));
    touch(path.join(extLibs, '.dotfile.js'));
    touch(path.join(extLibs, '_internal.js'));
    expect(scanExternalLibraries(extLibs)).toEqual({});
  });

  test('ignores non-JS files at the root', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    touch(path.join(extLibs, 'README.md'));
    touch(path.join(extLibs, 'styles.css'));
    expect(scanExternalLibraries(extLibs)).toEqual({});
  });

  test('does not read package.json or fall back to index.js inside folders', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    const pkg = path.join(extLibs, 'three');
    fs.mkdirSync(pkg);
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ module: './build/three.module.js' }),
    );
    touch(path.join(pkg, 'build/three.module.js'));
    touch(path.join(pkg, 'index.js'));
    // Only the trailing-slash entry — neither package.json nor index.js
    // produces a bare 'three' entry; only external-libraries/three/three.js would.
    expect(scanExternalLibraries(extLibs)).toEqual({ 'three/': '/external-libraries/three/' });
  });
});

describe('readOverrides', () => {
  test('returns {} when file is missing', () => {
    expect(readOverrides(path.join(tmpRoot, 'missing.json'))).toEqual({});
  });

  test('returns {} on malformed JSON and logs an error', () => {
    const p = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(p, '{ not valid json');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readOverrides(p)).toEqual({});
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  test('returns imports map when valid', () => {
    const p = path.join(tmpRoot, 'ok.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ imports: { 'weird-lib': '/external-libraries/weird/main.js' } }),
    );
    expect(readOverrides(p)).toEqual({ 'weird-lib': '/external-libraries/weird/main.js' });
  });

  test('returns {} when JSON is valid but missing imports key', () => {
    const p = path.join(tmpRoot, 'no-imports.json');
    fs.writeFileSync(p, JSON.stringify({ something: 'else' }));
    expect(readOverrides(p)).toEqual({});
  });
});

describe('buildImportMap', () => {
  test('overrides win over auto-derived entries', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    touch(path.join(extLibs, 'three.js'));

    const override = path.join(tmpRoot, 'external-modules.json');
    fs.writeFileSync(
      override,
      JSON.stringify({ imports: { three: '/external-libraries/three/custom-entry.js' } }),
    );

    const map = buildImportMap(extLibs, override);
    expect(map.imports.three).toBe('/external-libraries/three/custom-entry.js');
  });

  test('combines folder-convention and loose-root entries', () => {
    const extLibs = path.join(tmpRoot, 'external-libraries');
    fs.mkdirSync(extLibs);
    fs.mkdirSync(path.join(extLibs, 'three'));
    touch(path.join(extLibs, 'three/three.js'));
    fs.mkdirSync(path.join(extLibs, 'uplot'));
    touch(path.join(extLibs, 'uplot/uplot.js'));
    touch(path.join(extLibs, 'tiny.js'));

    const map = buildImportMap(extLibs, path.join(tmpRoot, 'missing.json'));
    expect(map.imports).toEqual({
      three: '/external-libraries/three/three.js',
      'three/': '/external-libraries/three/',
      uplot: '/external-libraries/uplot/uplot.js',
      'uplot/': '/external-libraries/uplot/',
      tiny: '/external-libraries/tiny.js',
    });
  });
});

describe('resolveLiveProjectDir', () => {
  const ENV_KEYS = ['NEXTHMI_ACTIVE_PROJECT_PATH', 'NEXTHMI_DATA_DIR', 'XDG_CONFIG_HOME'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    // Point the bootstrap-config lookup at an empty dir so a real
    // ~/.config/nexthmi/runtime.json on the dev machine can't leak in.
    process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'xdg');
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeManifest(home: string, manifest: unknown): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify(manifest));
  }

  test('honours an explicit NEXTHMI_ACTIVE_PROJECT_PATH above everything', () => {
    process.env.NEXTHMI_ACTIVE_PROJECT_PATH = path.join(tmpRoot, 'explicit');
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'home');
    writeManifest(path.join(tmpRoot, 'home'), {
      defaultProjectId: 'a',
      projects: [{ id: 'a', path: path.join(tmpRoot, 'from-manifest') }],
    });
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'explicit'));
  });

  test('picks the manifest default, wherever on disk it lives', () => {
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'home');
    writeManifest(path.join(tmpRoot, 'home'), {
      defaultProjectId: 'b',
      projects: [
        { id: 'a', path: path.join(tmpRoot, 'line-a') },
        { id: 'b', path: path.join(tmpRoot, 'line-b') },
      ],
    });
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'line-b'));
  });

  test('picks the only registered project when no default is set', () => {
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'home');
    writeManifest(path.join(tmpRoot, 'home'), {
      projects: [{ id: 'a', path: path.join(tmpRoot, 'sibling-testbench') }],
    });
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'sibling-testbench'));
  });

  test('refuses to guess between several projects with no default', () => {
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'home');
    writeManifest(path.join(tmpRoot, 'home'), {
      projects: [
        { id: 'a', path: path.join(tmpRoot, 'line-a') },
        { id: 'b', path: path.join(tmpRoot, 'line-b') },
      ],
    });
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'project-testbench'));
  });

  test('falls back to the in-repo project-testbench when there is no manifest', () => {
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'empty-home');
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'project-testbench'));
  });

  test('survives a corrupt manifest rather than throwing at dev-server startup', () => {
    const home = path.join(tmpRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'projects.json'), '{ not json');
    process.env.NEXTHMI_DATA_DIR = home;
    expect(resolveLiveProjectDir(tmpRoot)).toBe(path.join(tmpRoot, 'project-testbench'));
  });
});

describe('resolveRuntimeHome', () => {
  test('prefers NEXTHMI_DATA_DIR', () => {
    const saved = process.env.NEXTHMI_DATA_DIR;
    process.env.NEXTHMI_DATA_DIR = path.join(tmpRoot, 'pinned');
    try {
      expect(resolveRuntimeHome(tmpRoot)).toBe(path.join(tmpRoot, 'pinned'));
    } finally {
      if (saved === undefined) delete process.env.NEXTHMI_DATA_DIR;
      else process.env.NEXTHMI_DATA_DIR = saved;
    }
  });

  test('uses the in-repo dev home when one exists and nothing outranks it', () => {
    const saved = { data: process.env.NEXTHMI_DATA_DIR, xdg: process.env.XDG_CONFIG_HOME };
    delete process.env.NEXTHMI_DATA_DIR;
    process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'xdg');
    fs.mkdirSync(path.join(tmpRoot, '.dev-runtime-home'), { recursive: true });
    try {
      expect(resolveRuntimeHome(tmpRoot)).toBe(path.join(tmpRoot, '.dev-runtime-home'));
    } finally {
      if (saved.data === undefined) delete process.env.NEXTHMI_DATA_DIR;
      else process.env.NEXTHMI_DATA_DIR = saved.data;
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.xdg;
    }
  });
});
