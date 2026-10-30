import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where the dev server should read the live project's `external-libraries/`
 * and `external-modules.json` from.
 *
 * Resolved the way the backend does (`core/runtime_home.py` and
 * `core/bootstrap.py`): a live project can live anywhere, and a wrong guess
 * leaves the import map empty so every bare specifier fails at runtime.
 * `<repo>/project-testbench/` is the last fallback.
 */

function bootstrapConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData
      ? path.join(appData, 'NextHMI', 'runtime.json')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'NextHMI', 'runtime.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, 'nexthmi', 'runtime.json')
    : path.join(os.homedir(), '.config', 'nexthmi', 'runtime.json');
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runtime home, in the backend's precedence order. `repoRoot` supplies the
 *  dev fallback that only applies when running from a checkout. */
export function resolveRuntimeHome(repoRoot: string): string {
  const env = process.env.NEXTHMI_DATA_DIR;
  if (env) return path.resolve(env);

  const bootstrap = readJson(bootstrapConfigPath());
  const dataDir = bootstrap?.dataDir;
  if (typeof dataDir === 'string' && dataDir.trim()) return path.resolve(dataDir);

  const devHome = path.join(repoRoot, '.dev-runtime-home');
  if (fs.existsSync(devHome)) return devHome;

  return path.join(os.homedir(), 'Documents', 'NextHMI');
}

/**
 * The project the dev server is serving: the manifest's default entry, else its
 * only entry (the common dev case), else the legacy `project-testbench/`.
 * Ambiguity is deliberately not guessed at — with several registered projects
 * and no default, there is no right answer, so the caller gets the fallback.
 */
export function resolveLiveProjectDir(repoRoot: string): string {
  const explicit = process.env.NEXTHMI_ACTIVE_PROJECT_PATH;
  if (explicit) return path.resolve(explicit);

  const manifest = readJson(path.join(resolveRuntimeHome(repoRoot), 'projects.json'));
  const entries = Array.isArray(manifest?.projects)
    ? (manifest.projects as Array<Record<string, unknown>>)
    : [];
  const byId = entries.find((entry) => entry.id === manifest?.defaultProjectId);
  const chosen = byId ?? (entries.length === 1 ? entries[0] : undefined);
  if (typeof chosen?.path === 'string' && chosen.path.trim()) return path.resolve(chosen.path);

  return path.join(repoRoot, 'project-testbench');
}

/**
 * A registered project's folder by id, the `<slug>` of `/runtime/<slug>/` and
 * `/editor/<slug>/`, so each instance document gets its own project's import
 * map rather than the default project's. Undefined when it isn't registered.
 */
export function resolveProjectDirById(repoRoot: string, id: string): string | undefined {
  const manifest = readJson(path.join(resolveRuntimeHome(repoRoot), 'projects.json'));
  const entries = Array.isArray(manifest?.projects)
    ? (manifest.projects as Array<Record<string, unknown>>)
    : [];
  const entry = entries.find((e) => e.id === id);
  return typeof entry?.path === 'string' && entry.path.trim()
    ? path.resolve(entry.path)
    : undefined;
}

export function scanExternalLibraries(externalLibrariesDir: string): Record<string, string> {
  if (!fs.existsSync(externalLibrariesDir)) return {};
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(externalLibrariesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      const bareName = entry.name.replace(/\.m?js$/, '');
      out[bareName] = `/external-libraries/${entry.name}`;
    } else if (entry.isDirectory()) {
      out[`${entry.name}/`] = `/external-libraries/${entry.name}/`;
      // Convention: external-libraries/<name>/<name>.js (or .mjs) is the bare entry.
      for (const ext of ['.js', '.mjs']) {
        const file = `${entry.name}${ext}`;
        if (fs.existsSync(path.join(externalLibrariesDir, entry.name, file))) {
          out[entry.name] = `/external-libraries/${entry.name}/${file}`;
          break;
        }
      }
    }
  }
  return out;
}

export function readOverrides(overridePath: string): Record<string, string> {
  if (!fs.existsSync(overridePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    return raw?.imports && typeof raw.imports === 'object' ? raw.imports : {};
  } catch (err) {
    console.error('[NEXTHMI] external-modules.json is invalid JSON:', err);
    return {};
  }
}

export function buildImportMap(
  externalLibrariesDir: string,
  overridePath: string,
): { imports: Record<string, string> } {
  return {
    imports: { ...scanExternalLibraries(externalLibrariesDir), ...readOverrides(overridePath) },
  };
}
