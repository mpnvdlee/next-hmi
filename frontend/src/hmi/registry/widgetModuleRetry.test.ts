import type { WidgetConfig } from '@shared/types/config';
import { loadWidgetModule } from '@shared/utils/widgetModuleLoader';
import {
  prefetchWidgetModules,
  registerCustomWidget,
  widgetModulesLoaded,
  type CustomWidgetManifestEntry,
} from './widgetRegistry';

vi.mock('@shared/utils/widgetModuleLoader', () => ({
  loadWidgetModule: vi.fn(),
}));

const ENTRY = {
  key: 'Test/Flaky',
  name: 'Flaky',
  group: 'Test',
  origin: 'project',
  usesRecharts: false,
  buildOk: true,
  buildTs: '1',
  displayName: 'Flaky',
} as unknown as CustomWidgetManifestEntry;

const TREE: WidgetConfig[] = [{ id: 'w1', type: 'Flaky', name: 'w1' }];

describe('widget module load failure', () => {
  it('retries a module whose first fetch failed instead of memoising the failure', async () => {
    const load = vi.mocked(loadWidgetModule);
    load.mockRejectedValueOnce(new Error('network'));
    load.mockResolvedValueOnce({ default: () => null });

    registerCustomWidget(ENTRY);

    await prefetchWidgetModules(TREE);
    expect(widgetModulesLoaded(TREE)).toBe(false);

    // A memoised rejection would leave the type "not loaded" forever, so every
    // page holding it sat out the reveal gate's full timeout until a reload.
    await prefetchWidgetModules(TREE);
    expect(widgetModulesLoaded(TREE)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
