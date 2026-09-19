import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentStore } from '@shared/store/componentStore';
import { allPageRootNodes, flattenPages } from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';

export type PreviewPoster = (message: Record<string, unknown>) => void;

/** `pageIds` restricts which pages' content travels. Omitted means every
 *  loaded page, which is what the editor canvas needs because it can navigate
 *  between them without asking the parent for more. */
export function buildPagesUpdate(pageIds?: string[]): Record<string, unknown> {
  const s = useConfigStore.getState();
  const wanted = pageIds ? new Set(pageIds) : s.loadedPageIds;
  const pageContent: Record<string, unknown[]> = {};
  for (const page of flattenPages(allPageRootNodes(s))) {
    if (wanted.has(page.id)) {
      pageContent[page.id] = getPageChildren(page) as unknown[];
    }
  }
  return {
    type: 'pages_update',
    pages: s.pages,
    dialogs: s.dialogs,
    header: s.header,
    footer: s.footer,
    leftSidebar: s.leftSidebar,
    rightSidebar: s.rightSidebar,
    shell: s.shell,
    globalEvents: s.globalEvents,
    pageContent,
  };
}

export function buildTranslationsUpdate(): Record<string, unknown> {
  const s = useTranslationStore.getState();
  return {
    type: 'translations_update',
    languages: s.languages,
    translations: s.translations,
  };
}

export function buildComponentsUpdate(): Record<string, unknown> {
  const s = useComponentStore.getState();
  return {
    type: 'components_update',
    components: s.components,
    draftComponents: s.draftComponents,
  };
}

export function syncAllTo(post: PreviewPoster, pageIds?: string[]): void {
  post(buildPagesUpdate(pageIds));
  post(buildTranslationsUpdate());
  post(buildComponentsUpdate());
}
