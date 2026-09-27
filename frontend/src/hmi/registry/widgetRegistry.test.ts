import { describe, it, expect, afterEach, vi } from 'vitest';
// The palette-icon guard below enumerates entries that *have* an icon, and a
// built-in widget only gets one once the manifest's editor half is applied.
// Without this the suite would still pass — with 34 fewer cases.
import './builtinWidgetsEditorMetadata';
import { BUILTIN_ICON_IDS } from '@shared/config/iconAllowlist';
import type { IconValue } from '@shared/types/config';
import {
  widgetRegistry,
  resolveWidgetMetadata,
  registerCustomWidget,
  registerComponents,
  collectWidgetTypes,
  prefetchWidgetModules,
  widgetModulesLoaded,
  BUILTIN_WIDGET_TYPES,
  VISIBILITY_SCHEMA,
  type CustomWidgetManifestEntry,
} from './widgetRegistry';
import { useComponentStore } from '@shared/store/componentStore';
import { suspendStylesheetAutoLoad } from '../../test-setup';
import type { WidgetConfig } from '@shared/types/config';
import universalPropertyKeysFixture from '@shared/types/__fixtures__/universalWidgetPropertyKeys.json';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { UNIVERSAL_PROPERTY_KEYS } from '@shared/types/universalWidgetProperties';

function expectAllowlistedBuiltin(icon: IconValue | undefined): void {
  expect(icon?.type).toBe('builtin');
  if (icon?.type !== 'builtin') return;
  expect([...BUILTIN_ICON_IDS]).toContain(icon.name);
}

describe('VISIBILITY_SCHEMA', () => {
  it('matches the shared fixture also read by backend/core/validation/structure.py', () => {
    expect(new Set(universalPropertyKeysFixture as string[])).toEqual(
      new Set(Object.keys(VISIBILITY_SCHEMA)),
    );
  });

  it('matches the runtime list the binding overlay reads', () => {
    // bindingValidation cannot import this module (registry → ComponentRenderer
    // → WidgetRenderer → bindingValidation), so it reads UNIVERSAL_PROPERTY_KEYS
    // instead. A gate property added to only one of the two would leave the
    // overlay marking a widget that renders correctly.
    expect(UNIVERSAL_PROPERTY_KEYS).toEqual(new Set(Object.keys(VISIBILITY_SCHEMA)));
  });
});

describe('widget palette icons', () => {
  const entries = Object.entries(widgetRegistry).filter(([, entry]) => entry.icon);

  it('covers the registry', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s uses an allowlisted built-in icon', (_type, entry) => {
    expectAllowlistedBuiltin(entry.icon);
  });

  it('falls back to allowlisted icons for entries without one', () => {
    const builtinType = [...BUILTIN_WIDGET_TYPES][0];
    for (const type of [builtinType, '__unregistered_custom_widget__']) {
      expectAllowlistedBuiltin(resolveWidgetMetadata(type).icon);
    }
  });
});

describe('registerCustomWidget', () => {
  const REGISTERED: string[] = [];

  function register(overrides: Partial<CustomWidgetManifestEntry> = {}) {
    const entry: CustomWidgetManifestEntry = {
      key: 'Aquavane/OeeRing',
      name: 'OeeRing',
      group: 'Aquavane',
      hasStyle: true,
      buildTs: '2026-08-11T10:00:00Z',
      ...overrides,
    };
    REGISTERED.push(entry.name);
    registerCustomWidget(entry);
    return widgetRegistry[entry.name];
  }

  afterEach(() => {
    for (const name of REGISTERED.splice(0)) {
      if (!BUILTIN_WIDGET_TYPES.has(name)) delete widgetRegistry[name];
    }
    vi.restoreAllMocks();
  });

  it('registers schema and catalog metadata without importing the module', () => {
    const entry = register({
      schema: { value: { type: 'Float', label: 'Value' } },
      category: 'Aquavane',
      description: 'A donut ring.',
      icon: { type: 'builtin', name: 'gauge' },
      exportedProperties: [{ key: 'selectedValue', label: 'Selected value', type: 'string' }],
    });

    expect(Object.keys(entry.schema ?? {})).toContain('value');
    expect(entry.description).toBe('A donut ring.');
    expect(entry.icon).toEqual({ type: 'builtin', name: 'gauge' });
    expect(entry.exportedProperties?.[0].key).toBe('selectedValue');
  });

  it('always merges the visibility fields into the manifest schema', () => {
    const entry = register({ schema: { value: { type: 'Float', label: 'Value' } } });
    for (const key of Object.keys(VISIBILITY_SCHEMA)) {
      expect(Object.keys(entry.schema ?? {})).toContain(key);
    }
  });

  it('falls back to the source folder when the module declares no category', () => {
    expect(register({ category: null }).category).toBe('Aquavane');
    expect(register({ name: 'Ungrouped', category: null, group: null }).category).toBe('Other');
  });

  it('warns when a custom widget shadows a built-in, and still registers it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const builtinBefore = widgetRegistry.PageTitle;

    const entry = register({ key: 'Other/PageTitle', name: 'PageTitle', group: 'Other' });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('Other/PageTitle');
    expect(warn.mock.calls[0][0]).toContain('PageTitle');
    expect(entry.component).not.toBe(builtinBefore.component);

    widgetRegistry.PageTitle = builtinBefore;
  });

  it('stays quiet for a name that collides with nothing built-in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    register();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('registerComponents slot properties', () => {
  afterEach(() => registerComponents([]));

  function register(properties: Record<string, unknown>, slots: string[]) {
    registerComponents([
      {
        id: 'card',
        name: 'Card',
        componentProperties: properties,
        children: slots.map((slot, i) => ({
          id: `s${i}`,
          type: 'ComponentSlot',
          name: slot,
          properties: { slot },
        })),
      } as unknown as ComponentDefinition,
    ]);
    return widgetRegistry['$component:card'];
  }

  it('gives a declared slot its panel row', () => {
    const entry = register({ body: { type: 'widgets', label: 'Body' } }, ['body']);

    expect(entry.schema?.body?.label).toBe('Body');
    expect(entry.slots).toEqual(['body']);
  });

  it('drops a slot property no ComponentSlot names — the row would edit a hole', () => {
    const entry = register({ body: { type: 'widgets', label: 'Body' } }, ['other']);

    expect(entry.schema?.body).toBeUndefined();
  });

  it('strips the value fields a slot property cannot have', () => {
    const entry = register(
      { body: { type: 'widgets', label: 'Body', defaultValue: 'x', write: true } },
      ['body'],
    );

    expect(entry.schema?.body).toEqual({ type: 'widgets', label: 'Body' });
  });
});

describe('widget module prefetch', () => {
  function node(id: string, type: string, children?: WidgetConfig[]): WidgetConfig {
    return { id, type, name: id, ...(children ? { children } : {}) };
  }

  afterEach(() => {
    useComponentStore.setState({ components: [], draftComponents: {} });
  });

  it('collects nested types, and the widgets a component definition draws', () => {
    useComponentStore.setState({
      components: [
        { id: 'card', name: 'Card', children: [node('inner', 'Gauge')] } as ComponentDefinition,
      ],
    });

    const types = collectWidgetTypes([
      node('a', 'Container', [node('b', 'Label'), node('c', '$component:card')]),
    ]);

    expect([...types].sort()).toEqual(['$component:card', 'Container', 'Gauge', 'Label'].sort());
  });

  it('reports a tree unready until its modules land, then ready', async () => {
    const tree = [node('a', 'Clock')];
    expect(widgetModulesLoaded(tree)).toBe(false);

    await prefetchWidgetModules(tree);

    expect(widgetModulesLoaded(tree)).toBe(true);
  });

  function styleLink(name: string): HTMLLinkElement | null {
    return document.head.querySelector(`link[data-dynamic-stylesheet*="/${name}/style.css"]`);
  }

  it('holds the prefetch open until the widget stylesheet lands, not just its module', async () => {
    // Without suspending the harness's stand-in for jsdom's missing fetch, the
    // stylesheet would land on its own and this would pass on the module wait
    // alone — proving nothing about the CSS.
    const restoreAutoLoad = suspendStylesheetAutoLoad();
    try {
      // The gap this closes: the module used to be the whole answer, so the
      // page gate revealed while the CSS was still in flight and the widget
      // painted unstyled first.
      const tree = [node('a', 'Icon')];
      let settled = false;
      const prefetch = prefetchWidgetModules(tree).then(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(styleLink('Icon')).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(widgetModulesLoaded(tree)).toBe(false);

      styleLink('Icon')!.dispatchEvent(new Event('load'));
      await prefetch;

      expect(settled).toBe(true);
      expect(widgetModulesLoaded(tree)).toBe(true);
    } finally {
      restoreAutoLoad();
    }
  });

  it('drops the previous build stylesheet once a recompile has re-registered the widget', async () => {
    // A `widget_updated` recompile mints a new href. Pinned stylesheets would
    // otherwise pile up across an editing session, the superseded builds still
    // in <head>.
    const entry = {
      key: 'Test/Restyled',
      name: 'Restyled',
      group: 'Test',
      origin: 'project',
      hasStyle: true,
      buildTs: '1',
    } as unknown as CustomWidgetManifestEntry;
    const tree = [node('a', 'Restyled')];
    const stamped = (t: string) =>
      document.head.querySelector(`link[data-dynamic-stylesheet*="/Restyled/style.css?t=${t}"]`);

    try {
      registerCustomWidget(entry);
      await prefetchWidgetModules(tree);
      expect(stamped('1')).not.toBeNull();

      registerCustomWidget({ ...entry, buildTs: '2' });
      await prefetchWidgetModules(tree);

      expect(stamped('2')).not.toBeNull();
      expect(stamped('1')).toBeNull();
    } finally {
      delete widgetRegistry['Restyled'];
    }
  });

  it('never waits on a type nothing registered — there is no module to load', () => {
    expect(widgetModulesLoaded([node('a', '__unregistered_custom_widget__')])).toBe(true);
  });

  it('re-walks the same tree once a component definition arrives', () => {
    // The walk is memoised per tree, but the answer depends on the component
    // store: a page gate that asked before the definitions loaded would
    // otherwise keep the empty answer and reveal without the module.
    const tree = [node('a', 'Container', [node('c', '$component:late')])];
    expect([...collectWidgetTypes(tree)].sort()).toEqual(['$component:late', 'Container']);

    useComponentStore.setState({
      components: [
        { id: 'late', name: 'Late', children: [node('inner', 'Gauge')] } as ComponentDefinition,
      ],
    });

    expect([...collectWidgetTypes(tree)].sort()).toEqual(['$component:late', 'Container', 'Gauge']);
  });
});
