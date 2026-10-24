import { useEffect } from 'react';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useNavigateToPage } from '@hmi/hooks/useNavigateToPage';

/** Routes a `navigateToPage` action through the navigation widgets' own hook,
 *  so the page events fire as they do for a menu press. Lives beside the alert. */
export function ActionNavigation() {
  const pageId = useHmiStore((s) => s.pendingNavigation);
  const navigateToPage = useNavigateToPage();
  useEffect(() => {
    if (!pageId) return;
    useHmiStore.setState({ pendingNavigation: null });
    navigateToPage(pageId);
  }, [pageId, navigateToPage]);
  return null;
}
