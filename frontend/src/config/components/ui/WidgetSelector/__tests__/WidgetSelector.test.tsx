import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ComponentType } from 'react';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import type { HmiWidgetProps } from '@shared/types/config';
import { buildCatalog, CATEGORY_ORDER } from '../catalog';
import WidgetSelector from '../index';

const Noop: ComponentType<HmiWidgetProps> = () => null;

beforeAll(() => {
  // jsdom lacks IntersectionObserver; the drawer's scroll-spy sets one up on mount.
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error assigning a test stub
  global.IntersectionObserver = IntersectionObserverStub;
});

afterEach(cleanup);

describe('buildCatalog', () => {
  it('lists the alarm and trend widgets under "Content & controls"', () => {
    const content = buildCatalog().find((c) => c.category === 'Content & controls');
    expect(content).toBeDefined();
    expect(content!.items.map((i) => i.type)).toEqual(
      expect.arrayContaining(['TrendChart', 'AlarmListManaged', 'AlarmHistoryList']),
    );
  });

  it('orders built-in categories per CATEGORY_ORDER', () => {
    const cats = buildCatalog().map((c) => c.category);
    const builtin = cats.filter((c) => (CATEGORY_ORDER as readonly string[]).includes(c));
    // A listed category with no registered widget is skipped, so compare against
    // the subset of CATEGORY_ORDER the registry actually populates.
    expect(builtin).toEqual((CATEGORY_ORDER as readonly string[]).filter((c) => cats.includes(c)));
  });

  it('groups entries by declared category and pins Components last', () => {
    widgetRegistry.FakeInput = {
      name: 'Fake Input',
      component: Noop,
      schema: {},
      category: 'Site widgets',
    };
    widgetRegistry['$component:x'] = {
      name: 'My Component',
      component: Noop,
      schema: {},
      category: 'Components',
    };
    try {
      const cats = buildCatalog();
      const categories = cats.map((c) => c.category);
      const projectGroup = cats.find((c) => c.category === 'Site widgets');
      const components = cats.find((c) => c.category === 'Components');

      expect(projectGroup?.items.map((i) => i.type)).toContain('FakeInput');
      expect(components?.items.map((i) => i.type)).toContain('$component:x');
      // Fallback icon for any non-built-in entry without an author-declared icon.
      expect(projectGroup?.items.find((i) => i.type === 'FakeInput')?.icon).toEqual({
        type: 'builtin',
        name: 'puzzle-piece',
      });
      expect(components?.items.find((i) => i.type === '$component:x')?.icon).toEqual({
        type: 'builtin',
        name: 'puzzle-piece',
      });
      // Components is pinned after the sorted custom groups.
      expect(categories.indexOf('Components')).toBeGreaterThan(categories.indexOf('Site widgets'));
    } finally {
      delete widgetRegistry.FakeInput;
      delete widgetRegistry['$component:x'];
    }
  });

  it('flags product-shipped entries as built-in and project ones as not', () => {
    widgetRegistry.FakeInput = {
      name: 'Fake Input',
      component: Noop,
      schema: {},
      category: 'Site widgets',
    };
    try {
      const items = buildCatalog().flatMap((c) => c.items);
      expect(items.find((i) => i.type === 'NavigationMenu')?.builtin).toBe(true);
      expect(items.find((i) => i.type === 'FakeInput')?.builtin).toBe(false);
    } finally {
      delete widgetRegistry.FakeInput;
    }
  });

  it("uses a component's configured drawer metadata", () => {
    widgetRegistry['$component:meter'] = {
      name: 'Line Meter',
      component: Noop,
      schema: {},
      category: 'Process overview',
      description: 'Shows the current line throughput.',
      icon: { type: 'builtin', name: 'gauge' },
    };
    try {
      const category = buildCatalog().find((c) => c.category === 'Process overview');
      expect(category?.items).toContainEqual({
        type: '$component:meter',
        name: 'Line Meter',
        category: 'Process overview',
        description: 'Shows the current line throughput.',
        icon: { type: 'builtin', name: 'gauge' },
        builtin: false,
        component: true,
      });
    } finally {
      delete widgetRegistry['$component:meter'];
    }
  });
});

describe('WidgetSelector', () => {
  it('renders the category rail + cards and inserts on card click', () => {
    const onInsert = vi.fn();
    render(<WidgetSelector onClose={() => {}} onInsert={onInsert} />);

    // Category rail button.
    expect(screen.getByRole('button', { name: 'Content & controls' })).toBeTruthy();

    // Card name → click inserts by type.
    fireEvent.click(screen.getByText('Button'));
    expect(onInsert).toHaveBeenCalledWith('Button');
  });

  it('badges built-in, custom and component cards', () => {
    widgetRegistry.FakeInput = {
      name: 'Fake Input',
      component: Noop,
      schema: {},
      category: 'Site widgets',
    };
    widgetRegistry['$component:meter'] = {
      name: 'Meter',
      component: Noop,
      schema: {},
      category: 'Components',
    };
    try {
      render(<WidgetSelector onClose={() => {}} onInsert={() => {}} />);

      const badgeOf = (name: string) =>
        screen.getByText(name).closest('button')!.querySelector('.cfg-selection-card__badge')
          ?.textContent;

      expect(badgeOf('Navigation Menu')).toBe('Built-in');
      expect(badgeOf('Fake Input')).toBe('Custom');
      expect(badgeOf('Meter')).toBe('Component');
    } finally {
      delete widgetRegistry.FakeInput;
      delete widgetRegistry['$component:meter'];
    }
  });

  it('hides types the filter rejects', () => {
    widgetRegistry['$component:meter'] = {
      name: 'Meter',
      component: Noop,
      schema: {},
      category: 'Components',
    };
    try {
      render(
        <WidgetSelector
          filter={(type) => !type.startsWith('$component:')}
          onClose={() => {}}
          onInsert={() => {}}
        />,
      );

      expect(screen.queryByText('Meter')).toBeNull();
      expect(screen.getByText('Button')).toBeTruthy();
    } finally {
      delete widgetRegistry['$component:meter'];
    }
  });

  it('inserts the first search result when Enter is pressed', () => {
    const onInsert = vi.fn();
    render(<WidgetSelector onClose={() => {}} onInsert={onInsert} />);

    const search = screen.getByRole('searchbox', { name: 'Search widgets and components' });
    fireEvent.change(search, { target: { value: 'NavigationMenu' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onInsert).toHaveBeenCalledWith('NavigationMenu');
  });
});
