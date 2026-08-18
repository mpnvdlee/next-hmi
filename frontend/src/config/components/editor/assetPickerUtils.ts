import { useEffect, useState } from 'react';
import { apiJson } from '@shared/utils/api';
import { withBase } from '@shared/utils/runtimeBase';
import { matchesSearchWords } from '@shared/utils/search';

type AssetType = 'icon' | 'image';

interface WorkspaceAsset {
  name: string;
  path: string;
  type: AssetType;
}

export interface FolderContents<T> {
  /** Immediate child folder names (single path segment, not full paths) at this level, sorted. */
  folders: string[];
  /** Assets directly inside this folder (not in a deeper subfolder). */
  files: T[];
}

export function assetUrl(path: string): string {
  return withBase(`/assets/${path}`);
}

export function assetName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Folder path relative to the assets/icons or assets/images root, e.g. "path/to/pump.svg" -> "path/to". */
export function assetFolder(path: string): string {
  const parts = path.split('/').slice(1, -1);
  return parts.join('/');
}

/**
 * Splits `items` into the immediate child folders and direct files of
 * `currentFolder`, for Explorer-style drill-down browsing. `currentFolder` is
 * `""` for the root; deeper paths use `/` as the separator (no leading/trailing slash).
 */
export function folderContents<T extends { path: string }>(
  items: readonly T[],
  currentFolder: string,
): FolderContents<T> {
  const prefix = currentFolder ? `${currentFolder}/` : '';
  const folders = new Set<string>();
  const files: T[] = [];
  for (const item of items) {
    const folder = assetFolder(item.path);
    if (folder === currentFolder) {
      files.push(item);
    } else if (folder.startsWith(prefix)) {
      const child = folder.slice(prefix.length).split('/')[0];
      if (child) folders.add(child);
    }
  }
  return { folders: [...folders].sort((a, b) => a.localeCompare(b)), files };
}

/**
 * Case-insensitive, all-word filter. Returns `items` unchanged when `search`
 * is empty so callers don't need to guard around empty queries.
 */
export function filterBySearch<T>(
  items: readonly T[],
  search: string,
  getSearchable: (item: T) => string,
): readonly T[] {
  if (!search.trim()) return items;
  return items.filter((item) => matchesSearchWords(search, getSearchable(item)));
}

async function fetchWorkspaceAssets(
  type: AssetType,
  signal?: AbortSignal,
): Promise<WorkspaceAsset[]> {
  const items = await apiJson<WorkspaceAsset[]>('/api/assets', { signal });
  return items.filter((item) => item.type === type);
}

/**
 * Loads workspace assets of `type` whenever `enabled` flips true. Aborts an
 * in-flight fetch if the picker closes or `type` changes, so stale results
 * never land in state.
 */
export function useWorkspaceAssets(
  type: AssetType,
  enabled: boolean,
): { assets: WorkspaceAsset[]; loading: boolean; loadError: string | null } {
  const [assets, setAssets] = useState<WorkspaceAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    fetchWorkspaceAssets(type, ctrl.signal)
      .then((items) => {
        if (ctrl.signal.aborted) return;
        setAssets(items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load');
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [type, enabled]);

  return { assets, loading, loadError };
}
