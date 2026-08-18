import { useEffect } from 'react';
import { useConfigStore } from '../store/configStore';
import { withBase } from '@shared/utils/runtimeBase';
import { withAppName } from '@shared/utils/documentTitle';

const ORIGINAL_TITLE = typeof document !== 'undefined' ? document.title : '';

function getIconLink(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

const ORIGINAL_ICON_HREF = getIconLink()?.href ?? '';

function resolveIconHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return ORIGINAL_ICON_HREF;
  if (/^(https?:|data:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return withBase(trimmed);
  return withBase(`/assets/${trimmed}`);
}

export function useDocumentChrome(): void {
  const appTitle = useConfigStore((s) => s.shell.appTitle);
  const appIcon = useConfigStore((s) => s.shell.appIcon);

  useEffect(() => {
    document.title = withAppName(appTitle) ?? ORIGINAL_TITLE;
  }, [appTitle]);

  useEffect(() => {
    const link = getIconLink();
    if (!link) return;
    link.href = appIcon ? resolveIconHref(appIcon) : ORIGINAL_ICON_HREF;
  }, [appIcon]);
}
