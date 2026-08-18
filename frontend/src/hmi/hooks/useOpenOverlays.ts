import { useMemo } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { findPageById } from '@shared/utils/pageTree';
import type { DialogConfig, PageConfig } from '@shared/types/config';
import { useHmiStore, type DialogEntry, type PageOverlayEntry } from '../store/hmiStore';

interface ResolvedDialog {
  dialog: DialogConfig;
  entry: DialogEntry;
}

interface ResolvedPageOverlay {
  entry: PageOverlayEntry;
  page: PageConfig;
}

/** Resolve each open dialog entry to its DialogConfig, dropping entries whose dialog no longer exists. */
export function useResolvedDialogs(): ResolvedDialog[] {
  const dialogs = useConfigStore((s) => s.dialogs);
  const openDialogEntries = useHmiStore((s) => s.openDialogs);
  return useMemo(
    () =>
      openDialogEntries.flatMap((entry) => {
        const dialog = dialogs.find((d) => d.id === entry.id);
        return dialog ? [{ dialog, entry }] : [];
      }),
    [openDialogEntries, dialogs],
  );
}

/** Resolve each open page-overlay entry to its PageConfig, dropping entries whose page no longer exists. */
export function useResolvedPageOverlays(): ResolvedPageOverlay[] {
  const pages = useConfigStore((s) => s.pages);
  const openPageOverlayEntries = useHmiStore((s) => s.openPageOverlays);
  return useMemo(
    () =>
      openPageOverlayEntries.flatMap((entry) => {
        const page = findPageById(pages, entry.pageId);
        return page ? [{ entry, page }] : [];
      }),
    [openPageOverlayEntries, pages],
  );
}
