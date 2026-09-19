import { beforeEach, describe, expect, it } from 'vitest';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentStore } from '@shared/store/componentStore';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import {
  buildComponentsUpdate,
  buildPagesUpdate,
  buildTranslationsUpdate,
  syncAllTo,
} from './previewSync';

const HOME_WIDGET = { id: 'w-home', name: 'Home label', type: 'Label' };
const MOTOR_WIDGET = { id: 'w-motor', name: 'Motor label', type: 'Label' };
const HEADER_WIDGET = { id: 'w-header', name: 'Header label', type: 'Label' };

const CARD: ComponentDefinition = {
  id: 'card',
  name: 'Card',
  componentProperties: {},
  children: [],
};

/** Two loaded pages, so a message that ignored `pageIds` would carry one page
 *  too many rather than the empty object an unpopulated store makes
 *  indistinguishable from a correct restriction. */
beforeEach(() => {
  useConfigStore.setState({
    pages: [
      { id: 'home', type: 'page', title: 'Home', sections: { content: [HOME_WIDGET] } },
      { id: 'motor', type: 'page', title: 'Motor', sections: { content: [MOTOR_WIDGET] } },
    ],
    dialogs: [],
    header: [HEADER_WIDGET],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    shell: { leftSidebar: { expandedSize: '12rem' } },
    globalEvents: { onHmiLoaded: [] },
    loadedPageIds: new Set(['home', 'motor']),
  });
  useTranslationStore.setState({
    languages: [{ code: 'en' }, { code: 'nl' }],
    translations: { Start: { en: 'Start', nl: 'Starten' } },
  });
  useComponentStore.setState({ components: [CARD], draftComponents: {} });
});

describe('previewSync', () => {
  it('builds a pages_update carrying the shell regions', () => {
    const message = buildPagesUpdate();

    expect(message.type).toBe('pages_update');
    expect(message.header).toEqual([HEADER_WIDGET]);
    expect(message.footer).toEqual([]);
    expect(message.leftSidebar).toEqual([]);
    expect(message.rightSidebar).toEqual([]);
    expect(message.shell).toEqual({ leftSidebar: { expandedSize: '12rem' } });
    expect(message.dialogs).toEqual([]);
    expect(message.globalEvents).toEqual({ onHmiLoaded: [] });
    expect(message.pages).toHaveLength(2);
  });

  it('restricts pageContent to the requested pages', () => {
    const message = buildPagesUpdate(['motor']) as { pageContent: Record<string, unknown> };

    expect(Object.keys(message.pageContent)).toEqual(['motor']);
    expect(message.pageContent.motor).toEqual([MOTOR_WIDGET]);
  });

  it('carries every loaded page when no ids are named', () => {
    const message = buildPagesUpdate() as { pageContent: Record<string, unknown> };

    expect(Object.keys(message.pageContent).sort()).toEqual(['home', 'motor']);
  });

  it('sends no page content at all for an empty id list', () => {
    const message = buildPagesUpdate([]) as { pageContent: Record<string, unknown> };

    expect(Object.keys(message.pageContent)).toEqual([]);
  });

  it('builds translations and components messages', () => {
    expect(buildTranslationsUpdate()).toEqual({
      type: 'translations_update',
      languages: [{ code: 'en' }, { code: 'nl' }],
      translations: { Start: { en: 'Start', nl: 'Starten' } },
    });
    expect(buildComponentsUpdate()).toEqual({
      type: 'components_update',
      components: [CARD],
      draftComponents: {},
    });
  });

  it('posts pages, translations, and components in order', () => {
    const posted: Record<string, unknown>[] = [];
    syncAllTo((message) => posted.push(message));

    expect(posted.map((message) => message.type)).toEqual([
      'pages_update',
      'translations_update',
      'components_update',
    ]);
  });

  it('passes the requested page ids through to the pages message', () => {
    const posted: Record<string, unknown>[] = [];
    syncAllTo((message) => posted.push(message), ['home']);

    const pageContent = posted[0].pageContent as Record<string, unknown>;
    expect(Object.keys(pageContent)).toEqual(['home']);
  });
});
