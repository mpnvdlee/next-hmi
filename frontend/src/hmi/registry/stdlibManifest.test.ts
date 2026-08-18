import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../../generated/stdlibManifest.json';
import editorManifest from '../../generated/stdlibManifest.editor.json';
import { widgetRegistry } from './widgetRegistry';
import './stdlibEditorMetadata';
import type { CustomWidgetManifestEntry, StdlibEditorEntry } from '@shared/types/widgetSchema';

/**
 * Drift guard for the baked stdlib manifest.
 *
 * `npm run build:stdlib` regenerates it (and both `dev` and `build` run that
 * first), so drift heals locally the moment anyone builds. What this test
 * catches is a *committed* stale manifest: sources edited under widgets/
 * without the regenerated JSON alongside them.
 *
 * Two assertions do that. The cheap one compares the key set against a mirror
 * of the backend's `find_entries`, and runs everywhere. The whole-content one
 * re-runs the real generator into a scratch directory and compares — the only
 * honest way to check the *values*, because they come out of a tree-sitter
 * extractor and an esbuild content hash that a TypeScript re-implementation
 * could only approximate, and a second approximation of the truth is the drift
 * this file exists to prevent.
 *
 * The manifest ships as two files, and the second half of this suite guards the
 * seam: the runtime half must stay free of editor-only weight (that is the
 * whole point of the split), and the two must recombine into the whole schema
 * the properties panel expects.
 */
const STDLIB_ROOT = resolve(__dirname, '../../../widgets');

// The manifest is written by the backend compiler (`build:stdlib` shells out to
// `services.widget_compiler`), so discovery here must reject exactly what
// `find_entries` rejects. A folder the compiler skips but this test counts would
// report a stale manifest that regenerating can never fix.
const WIDGET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WINDOWS_RESERVED_SEGMENTS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** `_is_widget_segment` + `_is_ignored`. The regex already excludes a leading
 *  dot or underscore, so `_is_ignored` adds nothing here — kept named so the
 *  two sides stay comparable. Segments are ASCII by construction, which is why
 *  `toUpperCase()` stands in for Python's `.upper()`. */
function isWidgetSegment(name: string): boolean {
  return WIDGET_SEGMENT_RE.test(name) && !WINDOWS_RESERVED_SEGMENTS.has(name.toUpperCase());
}

/** A candidate widget directory: `withFileTypes` uses lstat semantics, so a
 *  symlinked directory reports `isDirectory() === false` — matching the
 *  backend's explicit `is_symlink()` skip. */
function isWidgetDir(entry: Dirent): boolean {
  return entry.isDirectory() && isWidgetSegment(entry.name);
}

/** `index.tsx` present as a real file. `lstat`, not `exists`, because the
 *  backend rejects a symlinked entry point. */
function hasEntryFile(dir: string): boolean {
  return lstatSync(join(dir, 'index.tsx'), { throwIfNoEntry: false })?.isFile() === true;
}

/** Mirror of the backend's `find_entries`
 *  (`backend/services/widget_compiler.py`): any directory holding an index.tsx,
 *  flat (`<Name>/`) or grouped (`<Group>/<Name>/`), minus symlinks, ignored
 *  names, non-canonical segments and case-insensitive identity collisions. */
function discoverKeys(root: string): string[] {
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return [];
  const keys: string[] = [];
  for (const level1 of readdirSync(root, { withFileTypes: true })) {
    if (!isWidgetDir(level1)) continue;
    const groupDir = join(root, level1.name);
    if (hasEntryFile(groupDir)) {
      keys.push(level1.name);
      continue;
    }
    for (const level2 of readdirSync(groupDir, { withFileTypes: true })) {
      if (!isWidgetDir(level2)) continue;
      if (hasEntryFile(join(groupDir, level2.name))) keys.push(`${level1.name}/${level2.name}`);
    }
  }
  return excludeCasefoldCollisions(keys).sort();
}

/** `_exclude_casefold_collisions`: two keys that differ only in case have no
 *  single identity on a case-insensitive filesystem, so the backend drops both
 *  rather than picking one. */
function excludeCasefoldCollisions(keys: string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const folded = key.toLowerCase();
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  return keys.filter((key) => counts.get(key.toLowerCase()) === 1);
}

const REPO_ROOT = resolve(__dirname, '../../../..');
const BACKEND_DIR = join(REPO_ROOT, 'backend');

/** The interpreter `scripts/build-stdlib.mjs` picks, chosen the same way and
 *  for the same reasons: the repo venv unless the caller points elsewhere, and
 *  `.exe` because a Windows venv has no extensionless `python`. */
function pythonCommand(): string {
  if (process.env.NEXTHMI_PYTHON) return process.env.NEXTHMI_PYTHON;
  const venv =
    process.platform === 'win32'
      ? join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
      : join(REPO_ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

const PYTHON = pythonCommand();

/** Whether this machine can run the compiler at all. A checkout with Node but
 *  no Python — or with Python but without `backend/requirements.txt` installed
 *  — cannot run `npm run build:stdlib` either, so it cannot have produced the
 *  drift this test looks for; skipping there beats failing on a missing
 *  interpreter. */
function compilerRunnable(): boolean {
  const probe = spawnSync(PYTHON, ['-c', 'import services.widget_compiler'], {
    cwd: BACKEND_DIR,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return probe.error === undefined && probe.status === 0;
}

/** Both halves as the sources would produce them right now, via the same CLI
 *  `build:stdlib` shells into. The build root is scratch, so this reads the
 *  widget sources and writes nothing the working tree or the served
 *  `public/stdlib-js/` can see — a green run must never be a run that quietly
 *  healed the drift it was asked to detect. */
function regenerate(scratch: string): { runtime: unknown; editor: unknown } {
  const manifestPath = join(scratch, 'stdlibManifest.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.widget_compiler',
      '--once',
      '--src-dir',
      STDLIB_ROOT,
      '--out-dir',
      join(scratch, 'build'),
      '--manifest',
      manifestPath,
    ],
    { cwd: BACKEND_DIR, encoding: 'utf-8', shell: process.platform === 'win32' },
  );
  expect(result.status, `widget compiler failed:\n${result.stderr ?? result.error}`).toBe(0);
  return {
    runtime: JSON.parse(readFileSync(manifestPath, 'utf-8')),
    editor: JSON.parse(readFileSync(join(scratch, 'stdlibManifest.editor.json'), 'utf-8')),
  };
}

const rows = manifest as unknown as CustomWidgetManifestEntry[];
const editorRows = editorManifest as unknown as Record<string, StdlibEditorEntry>;

/** Everything the runtime half is allowed to carry per schema field —
 *  `bindingValidation.ts` reads exactly these two. */
const RUNTIME_FIELD_KEYS = new Set(['type', 'requiredFields']);

describe('stdlib manifest', () => {
  it('lists exactly the widgets on disk', () => {
    expect(rows.map((row) => row.key).sort()).toEqual(discoverKeys(STDLIB_ROOT));
  });

  // The key set above only notices a widget appearing or disappearing. This
  // notices an edit: a schema field added, a label or default changed, a new
  // description — the drift that leaves every other check green, docs included,
  // because `widgetMetadata.docs.test.ts` regenerates the catalog from this
  // same manifest and so agrees with a stale one.
  it('matches what the widget sources produce today', (ctx) => {
    if (!compilerRunnable()) ctx.skip(`no runnable widget compiler at ${PYTHON}`);
    const scratch = mkdtempSync(join(tmpdir(), 'stdlib-manifest-'));
    try {
      const fresh = regenerate(scratch);
      const stale = 'stale baked manifest — run `npm run build:stdlib` and commit both halves';
      expect(rows, stale).toEqual(fresh.runtime);
      expect(editorRows, stale).toEqual(fresh.editor);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it('records every widget as having compiled', () => {
    const failed = rows.filter((row) => row.buildOk !== true);
    expect(failed.map((row) => row.key)).toEqual([]);
  });

  it('carries the catalog metadata the registry registers from', () => {
    for (const row of rows) {
      expect(row.origin, `${row.key} origin`).toBe('stdlib');
      expect(row.name, `${row.key} name`).toBeTruthy();
      expect(row.category, `${row.key} category`).toBeTruthy();
      expect(row.schemaError ?? null, `${row.key} schemaError`).toBeNull();
      // The recharts gate is a boolean decision made at build time; a null here
      // would silently fall back to awaiting the chart library on every import.
      expect(typeof row.usesRecharts, `${row.key} usesRecharts`).toBe('boolean');
    }
  });
});

describe('stdlib manifest split', () => {
  it('keeps editor-only weight out of the runtime half', () => {
    for (const row of rows) {
      expect(row.description ?? null, `${row.key} description`).toBeNull();
      expect(row.icon ?? null, `${row.key} icon`).toBeNull();
      expect(row.exportedProperties ?? null, `${row.key} exportedProperties`).toBeNull();
      for (const [key, field] of Object.entries(row.schema ?? {})) {
        const extra = Object.keys(field).filter((k) => !RUNTIME_FIELD_KEYS.has(k));
        expect(extra, `${row.key}.${key} carries editor-only attributes`).toEqual([]);
      }
    }
  });

  it('describes only widgets the runtime half lists', () => {
    const keys = new Set(rows.map((row) => row.key));
    for (const key of Object.keys(editorRows)) {
      expect(keys.has(key), `${key} is in the editor half but not the runtime half`).toBe(true);
    }
    // Every field the editor half describes must exist in the runtime half —
    // the runtime half is the one that carries the full field list.
    for (const row of rows) {
      const declared = Object.keys(row.schema ?? {});
      for (const key of Object.keys(editorRows[row.key]?.schema ?? {})) {
        expect(declared, `${row.key}.${key} has no runtime field`).toContain(key);
      }
    }
  });

  it('recombines into the whole schema the properties panel renders', () => {
    for (const row of rows) {
      const entry = widgetRegistry[row.name];
      expect(entry, `${row.key} is not registered`).toBeTruthy();
      expect(typeof entry.description, `${row.key} description`).toBe('string');
      expect(entry.icon, `${row.key} icon`).toBeTruthy();
      for (const [key, field] of Object.entries(row.schema ?? {})) {
        expect(entry.schema[key]?.type, `${row.key}.${key} type`).toEqual(field.type);
        expect(typeof entry.schema[key]?.label, `${row.key}.${key} label`).toBe('string');
      }
    }
  });
});
