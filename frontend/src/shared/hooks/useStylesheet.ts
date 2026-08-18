import { useEffect } from 'react';

/** Reference counts per stylesheet href — survives re-renders */
const refCounts = new Map<string, number>();

/**
 * Injects a `<link rel="stylesheet">` into `<head>` when the component mounts.
 * Removes it when the last consumer unmounts (reference-counted).
 *
 * @param href - Absolute URL of the stylesheet, or null/'' to do nothing.
 */
export function useStylesheet(href: string | null | undefined): void {
  useEffect(() => {
    if (!href) return;

    const prev = refCounts.get(href) ?? 0;
    refCounts.set(href, prev + 1);

    if (prev === 0) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset['dynamicStylesheet'] = href;
      document.head.appendChild(link);
    }

    return () => {
      const count = refCounts.get(href) ?? 0;
      if (count <= 1) {
        refCounts.delete(href);
        const existing = document.head.querySelector(
          `link[data-dynamic-stylesheet="${CSS.escape(href)}"]`,
        );
        existing?.remove();
      } else {
        refCounts.set(href, count - 1);
      }
    };
  }, [href]);
}
