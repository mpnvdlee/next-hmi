// Regenerate the guide's generated widget catalog and property-source table.
// A `VAR=1 cmd` prefix in package.json would not run on Windows, so the env var
// is set here and vitest is spawned from Node instead.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['vitest', 'run', 'src/hmi/registry/widgetMetadata.docs.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, UPDATE_DOCS: '1' },
});

process.exit(result.status ?? 1);
