import type { WidgetConfig, PageConfig } from '@shared/types/config';
import {
  appendToSection,
  getPageChildren,
  mapPageSections,
  replacePageSectionWidgets,
} from './pageContent';

function makeWidget(id: string): WidgetConfig {
  return { id, type: 'box', name: id };
}

function makePageConfig(widgets: WidgetConfig[] = []): PageConfig {
  return { id: 'page1', title: 'Page 1', sections: { content: widgets } };
}

describe('getPageChildren', () => {
  it('returns the flat list across sections in declaration order', () => {
    const page: PageConfig = {
      id: 'p1',
      title: 'Page',
      sections: { header: [makeWidget('a')], content: [makeWidget('b'), makeWidget('c')] },
    };
    expect(getPageChildren(page).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for a page with no widgets', () => {
    expect(getPageChildren(makePageConfig())).toEqual([]);
  });
});

describe('appendToSection', () => {
  it('appends a widget to the content section when no section is given', () => {
    const page = makePageConfig([makeWidget('a')]);
    const next = appendToSection(page, makeWidget('b'));
    expect(next.sections.content.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('defaults to content even when another section sorts first in the object', () => {
    const page: PageConfig = {
      id: 'page1',
      title: 'Page 1',
      sections: { header: [makeWidget('h1')], content: [makeWidget('a')] },
    };
    const next = appendToSection(page, makeWidget('b'));
    expect(next.sections.content.map((w) => w.id)).toEqual(['a', 'b']);
    expect(next.sections.header.map((w) => w.id)).toEqual(['h1']);
  });

  it('creates the target section when it does not yet exist', () => {
    const page = makePageConfig([makeWidget('a')]);
    const next = appendToSection(page, makeWidget('h1'), 'header');
    expect(next.sections.header.map((w) => w.id)).toEqual(['h1']);
    expect(next.sections.content.map((w) => w.id)).toEqual(['a']);
  });
});

describe('mapPageSections', () => {
  it('runs the mapper on every section with its widgets and id', () => {
    const page: PageConfig = {
      id: 'p',
      title: 'P',
      sections: { header: [makeWidget('h')], content: [makeWidget('c')] },
    };
    const next = mapPageSections(page, (widgets, sectionId) =>
      widgets.map((w) => ({ ...w, name: `${sectionId}:${w.id}` })),
    );
    expect(next.sections.header[0].name).toBe('header:h');
    expect(next.sections.content[0].name).toBe('content:c');
  });
});

describe('replacePageSectionWidgets', () => {
  it('distributes the new widget list across the page sections, preserving original section sizes', () => {
    const page: PageConfig = {
      id: 'p',
      title: 'P',
      sections: { header: [makeWidget('h1')], content: [makeWidget('c1'), makeWidget('c2')] },
    };
    const next = replacePageSectionWidgets(page, [
      makeWidget('n1'),
      makeWidget('n2'),
      makeWidget('n3'),
    ]);
    expect(next.header.map((w) => w.id)).toEqual(['n1']);
    expect(next.content.map((w) => w.id)).toEqual(['n2', 'n3']);
  });

  it('sinks leftover widgets into the final section so nothing is dropped', () => {
    const page: PageConfig = {
      id: 'p',
      title: 'P',
      sections: { header: [makeWidget('h1')], content: [makeWidget('c1')] },
    };
    const next = replacePageSectionWidgets(page, [
      makeWidget('n1'),
      makeWidget('n2'),
      makeWidget('n3'),
    ]);
    expect(next.header.map((w) => w.id)).toEqual(['n1']);
    expect(next.content.map((w) => w.id)).toEqual(['n2', 'n3']);
  });

  it('returns empty section arrays when the replacement list is empty', () => {
    const page: PageConfig = {
      id: 'p',
      title: 'P',
      sections: { content: [makeWidget('c1'), makeWidget('c2')] },
    };
    const next = replacePageSectionWidgets(page, []);
    expect(next.content).toEqual([]);
  });
});
