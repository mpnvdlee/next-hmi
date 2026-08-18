// Compile the product stdlib widgets once, on the build machine.
//
// The runtime compiles a *project's* custom widgets on load; the stdlib is
// compiled here instead so a deployment missing esbuild degrades exactly as it
// does today (project widgets only) rather than failing to render at all.
//
// Emits three things:
//   frontend/.stdlib-build/          build intermediates (status + schema manifest)
//   frontend/public/stdlib-js/       served artifacts — index.js + style.css per widget
//   frontend/src/generated/stdlibManifest{,.editor}.json   baked registry, imported
//     statically: the runtime half by widgetRegistry.tsx (so every route carries it)
//     and the editor half only from src/config/ (so no HMI route does)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(frontendDir, '..');

// Match start-dev.py's VENV_PYTHON: the repo-root venv, unless the caller points
// elsewhere. The `.exe` matters — a Windows venv has no extensionless `python`,
// so dropping it silently falls back to `python3`, which Windows rarely has.
const venvPython =
  process.platform === 'win32'
    ? join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : join(repoRoot, '.venv', 'bin', 'python');
const python = process.env.NEXTHMI_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python3');

const result = spawnSync(
  python,
  [
    '-m',
    'services.widget_compiler',
    '--once',
    '--src-dir',
    join(frontendDir, 'widgets'),
    '--out-dir',
    join(frontendDir, '.stdlib-build'),
    '--manifest',
    join(frontendDir, 'src', 'generated', 'stdlibManifest.json'),
    '--publish-dir',
    join(frontendDir, 'public', 'stdlib-js'),
  ],
  {
    cwd: join(repoRoot, 'backend'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

// Unlike a project widget, a stdlib widget that fails to compile is a product
// defect — fail the build rather than shipping a catalog with a hole in it.
if (result.error) {
  // No interpreter at all: the common case is a build environment that has Node
  // but no Python (a node-only CI job, a node-only Docker stage). It produces no
  // compiler output, so say what was actually tried.
  console.error(
    `\nstdlib widget build could not start: ${result.error.message}\n` +
      `Tried to run: ${python}\n` +
      'This build step needs Python with backend/requirements.txt installed. ' +
      'Point NEXTHMI_PYTHON at an interpreter, or — where the stdlib artifacts ' +
      'are already built elsewhere — run `npm run build:app` instead of `npm run build`.',
  );
} else if (result.status !== 0) {
  console.error('\nstdlib widget build failed — see the compiler output above.');
}

process.exit(result.status ?? 1);
