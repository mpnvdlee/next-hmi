import { useCallback, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { PreviewContext } from '@shared/context/PreviewContext';
import { announcePage } from '@hmi/utils/pageAnnouncer';

export function useNavigateToPage(): (pageId: string) => void {
  const navigate = useNavigate();
  const isPreview = useContext(PreviewContext);
  const prefix = isPreview ? '/preview/' : '/pages/';
  return useCallback(
    (pageId: string) => {
      if (!isPreview) announcePage(pageId);
      navigate(`${prefix}${pageId}`);
    },
    [navigate, prefix, isPreview],
  );
}
