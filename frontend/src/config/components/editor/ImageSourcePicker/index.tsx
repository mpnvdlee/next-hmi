/**
 * ImageSourcePicker — overlay for selecting an image value.
 *
 * Lists image files from the active project's assets/images/ via /api/assets.
 * Emits a bare ImageValue: { path }
 */

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { FolderSimple } from '@phosphor-icons/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import SearchHighlight, { SearchHighlightProvider } from '@config/components/ui/SearchHighlight';
import type { ImageValue } from '@shared/types/config';
import AssetPickerShell from '../AssetPickerShell';
import FolderBreadcrumb from '../FolderBreadcrumb';
import { assetUrl, filterBySearch, folderContents, useWorkspaceAssets } from '../assetPickerUtils';

const MAX_VISIBLE = 200;

const TILE_MIN = 4;
const TILE_MAX = 14;
const TILE_STEP = 0.5;
const TILE_DEFAULT = 6.5;
const TILE_KEY = 'cfg-asset-picker:image-tile';

function storedTileSize() {
  try {
    const raw = window.localStorage.getItem(TILE_KEY);
    const parsed = raw === null ? NaN : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.min(TILE_MAX, Math.max(TILE_MIN, parsed)) : TILE_DEFAULT;
  } catch {
    return TILE_DEFAULT;
  }
}

function storeTileSize(size: number) {
  try {
    window.localStorage.setItem(TILE_KEY, String(size));
  } catch {
    /* private mode / quota — the size just won't be remembered */
  }
}

export default function ImageSourcePicker() {
  const open = useEditorDomainStore(
    (s) => s.assetPickerOpen && s.assetPickerTarget?.type === 'image',
  );
  const target = useEditorDomainStore((s) =>
    s.assetPickerTarget?.type === 'image' ? s.assetPickerTarget : null,
  );
  const close = useEditorDomainStore((s) => s.closeAssetPicker);

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ImageValue | null>(null);
  const [folder, setFolder] = useState('');
  const [tileSize, setTileSize] = useState(storedTileSize);

  const changeTileSize = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    setTileSize(next);
    storeTileSize(next);
  }, []);

  const { assets: images, loading, loadError } = useWorkspaceAssets('image', open);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(null);
    setFolder('');
  }, [open]);

  const handleConfirm = useCallback(
    (val?: ImageValue) => {
      const v = val ?? selected;
      if (!v) return;
      target?.onPick(v);
      close();
    },
    [selected, target, close],
  );

  if (!open || !target) return null;

  const isSearching = search.trim().length > 0;
  const filtered = filterBySearch(images, search, (i) => `${i.path} ${i.name}`);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const { folders: subfolders, files: folderFiles } = folderContents(images, folder);
  const visibleFolderFiles = folderFiles.slice(0, MAX_VISIBLE);
  const selPath = selected?.path ?? null;

  const isEmpty = isSearching
    ? visible.length === 0
    : subfolders.length === 0 && visibleFolderFiles.length === 0;

  const countLabel = !loading ? (
    <>
      <span className="cfg-asset-picker-count">
        {filtered.length > MAX_VISIBLE ? `${MAX_VISIBLE} of ${filtered.length}` : filtered.length}
      </span>
      <input
        type="range"
        className="cfg-asset-picker-zoom"
        min={TILE_MIN}
        max={TILE_MAX}
        step={TILE_STEP}
        value={tileSize}
        onChange={(e) => changeTileSize(Number.parseFloat(e.target.value))}
        aria-label="Thumbnail size"
        title="Thumbnail size"
        style={
          {
            '--cfg-zoom-fill': `${((tileSize - TILE_MIN) / (TILE_MAX - TILE_MIN)) * 100}%`,
          } as CSSProperties
        }
      />
    </>
  ) : null;

  const selectionPreview = (
    <span className="cfg-asset-picker-selection">
      {selPath ? (
        <>
          <img src={assetUrl(selPath)} width={16} height={16} alt="" />
          <span>{selPath}</span>
        </>
      ) : (
        <span className="cfg-asset-picker-selection--empty">Nothing selected</span>
      )}
    </span>
  );

  return (
    <AssetPickerShell
      title={target?.label}
      action="Select image"
      onClose={close}
      onConfirm={() => handleConfirm()}
      confirmDisabled={!selected}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search images…"
      countLabel={countLabel}
      loading={loading}
      loadError={loadError}
      errorPrefix="images"
      selectionPreview={selectionPreview}
    >
      {!isSearching && folder && <FolderBreadcrumb folder={folder} onNavigate={setFolder} />}
      {isEmpty ? (
        <p className="cfg-asset-picker-empty">
          {images.length === 0
            ? "No images found. Place image files in the project's assets/images/."
            : isSearching
              ? 'No images match your search.'
              : 'This folder is empty.'}
        </p>
      ) : (
        <SearchHighlightProvider query={search}>
          <div
            className="cfg-asset-picker-sized"
            style={{ '--cfg-asset-tile': `${tileSize}rem` } as CSSProperties}
          >
            {!isSearching && subfolders.length > 0 && (
              <div className="cfg-asset-picker-folder-row cfg-asset-picker-folder-row--images">
                {subfolders.map((name) => (
                  <button
                    key={name}
                    title={name}
                    className="cfg-asset-picker-img-btn cfg-asset-picker-folder-btn"
                    type="button"
                    onClick={() => setFolder(folder ? `${folder}/${name}` : name)}
                  >
                    <FolderSimple size={Math.round(tileSize * 6.8)} weight="fill" />
                    <span className="cfg-asset-picker-img-btn__name">{name}</span>
                  </button>
                ))}
              </div>
            )}
            {!isSearching && subfolders.length > 0 && visibleFolderFiles.length > 0 && (
              <hr className="cfg-asset-picker-divider" />
            )}
            {(isSearching ? visible : visibleFolderFiles).length > 0 && (
              <div className="cfg-asset-picker-grid cfg-asset-picker-grid--images">
                {(isSearching ? visible : visibleFolderFiles).map((item) => (
                  <button
                    key={item.path}
                    title={item.path}
                    className={`cfg-asset-picker-img-btn${selPath === item.path ? ' cfg-asset-picker-img-btn--selected' : ''}`}
                    type="button"
                    onClick={() => setSelected({ path: item.path })}
                    onDoubleClick={() => handleConfirm({ path: item.path })}
                  >
                    <img src={assetUrl(item.path)} alt={item.name} />
                    <span className="cfg-asset-picker-img-btn__name">
                      <SearchHighlight text={item.name} />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </SearchHighlightProvider>
      )}
    </AssetPickerShell>
  );
}
