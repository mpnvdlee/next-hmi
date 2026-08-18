import { describe, it, expect, afterEach, vi } from 'vitest';
// The palette-icon guard below enumerates entries that *have* an icon, and a
// stdlib widget only gets one once the manifest's editor half is applied.
// Without this the suite would still pass — with 34 fewer cases.
import './stdlibEditorMetadata';
import { BUILTIN_ICON_IDS } from '@shared/config/iconAllowlist';
import type { IconValue } from '@shared/types/config';
import {
  widgetRegistry,
  resolveWidgetMetadata,
  registerCustomWidget,
  registerComponents,
  BUILTIN_WIDGET_TYPES,
  VISIBILITY_SCHEMA,
  type CustomWidgetManifestEntry,
} from './widgetRegistry';
import universalPropertyKeysFixture from '@shared/types/__fixtures__/universalWidgetPropertyKeys.json';
import type { ComponentDefinition } from '@shared/types/componentTypes';

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
