import { describe, expect, it } from 'vitest';
import {
  buildComponentsUpdate,
  buildPagesUpdate,
  buildTranslationsUpdate,
  syncAllTo,
} from './previewSync';

describe('previewSync', () => {
  it('builds a pages_update carrying the shell regions', () => {
    const message = buildPagesUpdate();
    expect(message.type).toBe('pages_update');
    for (const key of [
      'pages',
      'header',
      'footer',
      'leftSidebar',
      'rightSidebar',
      'shell',
      'dialogs',
      'globalEvents',
      'pageContent',
    ]) {
      expect(message).toHaveProperty(key);
    }
  });

  it('restricts pageContent to the requested pages', () => {
    const message = buildPagesUpdate([]) as { pageContent: Record<string, unknown> };
    expect(Object.keys(message.pageContent)).toEqual([]);
  });

  it('builds translations and components messages', () => {
    expect(buildTranslationsUpdate().type).toBe('translations_update');
    expect(buildComponentsUpdate().type).toBe('components_update');
  });

  it('posts pages, translations, and components in order', () => {
    const posted: Record<string, unknown>[] = [];
    syncAllTo((message) => posted.push(message));

    expect(posted).toHaveLength(3);
    expect(posted.map((message) => message.type)).toEqual([
      'pages_update',
      'translations_update',
      'components_update',
    ]);
    expect(posted[0]).toEqual(buildPagesUpdate());
    expect(posted[1]).toEqual(buildTranslationsUpdate());
    expect(posted[2]).toEqual(buildComponentsUpdate());
  });
});
