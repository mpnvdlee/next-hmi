import { loadWidgetModule } from '@shared/utils/widgetModuleLoader';
import builtinWidgetsManifest from '../../generated/builtinWidgetsManifest.json';
import {
  BUILTIN_WIDGET_TYPES,
  prefetchBuiltinWidgetModules,
  registerCustomWidget,
  type CustomWidgetManifestEntry,
} from './widgetRegistry';

vi.mock('@shared/utils/widgetModuleLoader', () => ({
  loadWidgetModule: vi.fn(() => Promise.resolve({ default: () => null })),
}));

const MANIFEST = builtinWidgetsManifest as unknown as CustomWidgetManifestEntry[];

/** A built-in the manifest declares chart-free, so the warm-up would fetch it. */
function warmedBuiltinName(): string {
  const entry = MANIFEST.find(
    (e) => e.usesRecharts === false && BUILTIN_WIDGET_TYPES.has(e.name),
  );
  if (!entry) throw new Error('no chart-free built-in in the manifest');
  return entry.name;
}

describe('prefetchBuiltinWidgetModules', () => {
  beforeEach(() => vi.mocked(loadWidgetModule).mockClear());

  it('warms a chart-free built-in', async () => {
    await prefetchBuiltinWidgetModules();
    const fetched = vi.mocked(loadWidgetModule).mock.calls.map(([path]) => path);
    expect(fetched.some((path) => path.includes(warmedBuiltinName()))).toBe(true);
  });

  it('stops warming a built-in once a project widget shadows it', async () => {
    // A project may override a built-in by name. The manifest still says this
    // type is chart-free, but the module the warm-up would now fetch is the
    // project's — which carries no such flag and pulls the chart library into
    // boot. Reading the flag off the manifest instead of off the registration
    // is what would get that wrong.
    const name = warmedBuiltinName();
    registerCustomWidget({
      key: `Project/${name}`,
      name,
      group: 'Project',
      hasStyle: false,
      buildTs: '2026-09-05T10:00:00Z',
    } as unknown as CustomWidgetManifestEntry);

    vi.mocked(loadWidgetModule).mockClear();
    await prefetchBuiltinWidgetModules();

    const fetched = vi.mocked(loadWidgetModule).mock.calls.map(([path]) => path);
    expect(fetched.some((path) => path.includes(name))).toBe(false);
  });
});
