/**
 * VideoSourcePicker — overlay for selecting a video value.
 *
 * Lists video files from the active project's assets/videos/ via /api/assets.
 * Emits a bare VideoValue: { path }
 *
 * A list rather than the image picker's thumbnail grid: nothing generates video
 * thumbnails, so a tile would be an empty box and the file's name, folder and
 * size are all there is to tell two clips apart.
 */

import { useState, useEffect, useCallback } from 'react';
import { FilmStrip, FolderSimple } from '@phosphor-icons/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import SearchHighlight, { SearchHighlightProvider } from '@config/components/ui/SearchHighlight';
import type { VideoValue } from '@shared/types/config';
import AssetPickerShell from '../AssetPickerShell';
import FolderBreadcrumb from '../FolderBreadcrumb';
import {
  assetFolder,
  filterBySearch,
  folderContents,
  useWorkspaceAssets,
} from '../assetPickerUtils';
import { formatBytes } from '@shared/utils/formatBytes';

const MAX_VISIBLE = 200;

export default function VideoSourcePicker() {
  const open = useEditorDomainStore(
    (s) => s.assetPickerOpen && s.assetPickerTarget?.type === 'video',
  );
  const target = useEditorDomainStore((s) =>
    s.assetPickerTarget?.type === 'video' ? s.assetPickerTarget : null,
  );
  const close = useEditorDomainStore((s) => s.closeAssetPicker);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<VideoValue | null>(null);
  const [folder, setFolder] = useState('');

  const { assets: videos, loading, loadError } = useWorkspaceAssets('video', open);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(null);
    setFolder('');
  }, [open]);

  const handleConfirm = useCallback(
    (val?: VideoValue) => {
      const v = val ?? selected;
      if (!v) return;
      target?.onPick(v);
      close();
    },
    [selected, target, close],
  );

  if (!open || !target) return null;

  const isSearching = search.trim().length > 0;
  const filtered = filterBySearch(videos, search, (v) => `${v.path} ${v.name}`);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const { folders: subfolders, files: folderFiles } = folderContents(videos, folder);
  const visibleFolderFiles = folderFiles.slice(0, MAX_VISIBLE);
  const selPath = selected?.path ?? null;

  const isEmpty = isSearching
    ? visible.length === 0
    : subfolders.length === 0 && visibleFolderFiles.length === 0;

  const countLabel = !loading ? (
    <span className="cfg-asset-picker-count">
      {filtered.length > MAX_VISIBLE ? `${MAX_VISIBLE} of ${filtered.length}` : filtered.length}
    </span>
  ) : null;

  const selectionPreview = (
    <span className="cfg-asset-picker-selection">
      {selPath ? (
        <>
          <FilmStrip size={16} />
          <span>{selPath}</span>
        </>
      ) : (
        <span className="cfg-asset-picker-selection--empty">Nothing selected</span>
      )}
    </span>
  );

  const rows = isSearching ? visible : visibleFolderFiles;

  return (
    <AssetPickerShell
      title={target.label}
      action="Select video"
      onClose={close}
      onConfirm={() => handleConfirm()}
      confirmDisabled={!selected}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search videos…"
      countLabel={countLabel}
      loading={loading}
      loadError={loadError}
      errorPrefix="videos"
      selectionPreview={selectionPreview}
    >
      {!isSearching && folder && <FolderBreadcrumb folder={folder} onNavigate={setFolder} />}
      {isEmpty ? (
        <p className="cfg-asset-picker-empty">
          {videos.length === 0
            ? "No videos found. Place video files in the project's assets/videos/."
            : isSearching
              ? 'No videos match your search.'
              : 'This folder is empty.'}
        </p>
      ) : (
        <SearchHighlightProvider query={search}>
          <div className="cfg-asset-picker-list">
            {!isSearching &&
              subfolders.map((name) => (
                <button
                  key={`folder:${name}`}
                  title={name}
                  className="cfg-asset-picker-row cfg-asset-picker-row--folder"
                  type="button"
                  onClick={() => setFolder(folder ? `${folder}/${name}` : name)}
                >
                  <FolderSimple size={18} weight="fill" />
                  <span className="cfg-asset-picker-row__name">{name}</span>
                </button>
              ))}
            {!isSearching && subfolders.length > 0 && rows.length > 0 && (
              <hr className="cfg-asset-picker-divider" />
            )}
            {rows.map((item) => (
              <button
                key={item.path}
                title={item.path}
                className={`cfg-asset-picker-row${selPath === item.path ? ' cfg-asset-picker-row--selected' : ''}`}
                type="button"
                onClick={() => setSelected({ path: item.path })}
                onDoubleClick={() => handleConfirm({ path: item.path })}
              >
                <FilmStrip size={18} />
                <span className="cfg-asset-picker-row__name">
                  <SearchHighlight text={item.name} />
                </span>
                <span className="cfg-asset-picker-row__folder">{assetFolder(item.path)}</span>
                <span className="cfg-asset-picker-row__size">{formatBytes(item.size)}</span>
              </button>
            ))}
          </div>
        </SearchHighlightProvider>
      )}
    </AssetPickerShell>
  );
}
