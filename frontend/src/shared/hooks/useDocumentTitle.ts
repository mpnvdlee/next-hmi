import { useEffect } from 'react';
import { APP_NAME, withAppName } from '@shared/utils/documentTitle';

/**
 * Sets the document title to `"NEXT HMI - <subtitle>"` for the manager surface
 * (which has no config-driven `appTitle`, so `useDocumentChrome` doesn't apply).
 * The app-name prefix lives in one place — see `withAppName`.
 */
export function useDocumentTitle(subtitle: string): void {
  useEffect(() => {
    document.title = withAppName(subtitle) ?? APP_NAME;
  }, [subtitle]);
}
