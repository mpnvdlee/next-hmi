/**
 * IconSourcePicker — overlay for selecting an icon value.
 *
 * Two tabs:
 *  - Built-in: curated Phosphor icon allowlist
 *  - Custom: SVG files from the active project's assets/icons/
 *
 * Emits a bare IconValue: { type, name | path }
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { FolderSimple } from '@phosphor-icons/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { BUILTIN_ICON_ALLOWLIST } from '@shared/config/iconAllowlist';
// Renders the full builtin icon grid synchronously (no per-tile Suspense
// flicker) — imports the icon map directly rather than the lazy HMI-runtime
// accessor in phosphorIcons.tsx (backlog item 22).
import { BUILTIN_ICON_COMPONENTS } from '@shared/utils/phosphorIconComponents';
import type { IconValue } from '@shared/types/config';
import AssetPickerShell from '../AssetPickerShell';
import FolderBreadcrumb from '../FolderBreadcrumb';
import {
  assetName,
  assetUrl,
  filterBySearch,
  folderContents,
  useWorkspaceAssets,
} from '../assetPickerUtils';

type Tab = 'builtin' | 'custom';

const MAX_VISIBLE = 200;
const BUILTIN_ICONS = BUILTIN_ICON_ALLOWLIST;

export default function IconSourcePicker() {
  const open = useEditorDomainStore(
    (s) => s.assetPickerOpen && s.assetPickerTarget?.type === 'icon',
  );
  const target = useEditorDomainStore((s) =>
    s.assetPickerTarget?.type === 'icon' ? s.assetPickerTarget : null,
  );
  const close = useEditorDomainStore((s) => s.closeAssetPicker);

  const [tab, setTab] = useState<Tab>('builtin');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<IconValue | null>(null);
  const [folder, setFolder] = useState('');

  const {
    assets: rawCustomIcons,
    loading,
    loadError,
  } = useWorkspaceAssets('icon', open && tab === 'custom');
  const customIcons = useMemo(
    () => rawCustomIcons.filter((asset) => asset.path.toLowerCase().endsWith('.svg')),
    [rawCustomIcons],
  );

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelected(null);
    setTab('builtin');
    setFolder('');
  }, [open]);

  const handleConfirm = useCallback(
    (val?: IconValue) => {
      const v = val ?? selected;
      if (!v) return;
      target?.onPick(v);
      close();
    },
    [selected, target, close],
  );

  if (!open || !target) return null;

  const filteredBuiltin = filterBySearch(
    BUILTIN_ICONS,
    search,
    (icon) => `${icon.label} ${icon.id}`,
  );
  const filteredCustom = filterBySearch(customIcons, search, (i) => `${i.path} ${i.name}`);

  const visibleBuiltin = filteredBuiltin.slice(0, MAX_VISIBLE);
  const visibleCustom = filteredCustom.slice(0, MAX_VISIBLE);

  const selName = selected?.type === 'builtin' ? selected.name : null;
  const selPath = selected?.type === 'custom' ? selected.path : null;

  const tabs = (
    <div className="cfg-asset-picker-tabs" role="tablist" aria-label="Icon source">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'builtin'}
        className={`cfg-asset-picker-tab${tab === 'builtin' ? ' cfg-asset-picker-tab--active' : ''}`}
        onClick={() => {
          setSearch('');
          setFolder('');
          setTab('builtin');
        }}
      >
        Built-in
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'custom'}
        className={`cfg-asset-picker-tab${tab === 'custom' ? ' cfg-asset-picker-tab--active' : ''}`}
        onClick={() => {
          setSearch('');
          setFolder('');
          setTab('custom');
        }}
      >
        Custom
      </button>
    </div>
  );

  const countLabel =
    !loading && tab === 'builtin' && BUILTIN_ICONS.length > 0 ? (
      <span className="cfg-asset-picker-count">
        {filteredBuiltin.length > MAX_VISIBLE
          ? `${MAX_VISIBLE} of ${filteredBuiltin.length}`
          : filteredBuiltin.length}
      </span>
    ) : null;

  const selectionPreview = (
    <span className="cfg-asset-picker-selection">
      {selName &&
        (() => {
          const IconComp = BUILTIN_ICON_COMPONENTS[selName] ?? null;
          return (
            <>
              {IconComp && <IconComp size={16} weight="regular" />}
              <span>{BUILTIN_ICONS.find((icon) => icon.id === selName)?.label ?? selName}</span>
            </>
          );
        })()}
      {selPath && (
        <>
          <img src={assetUrl(selPath)} width={16} height={16} alt="" />
          <span>{assetName(selPath)}</span>
        </>
      )}
      {!selName && !selPath && (
        <span className="cfg-asset-picker-selection--empty">Nothing selected</span>
      )}
    </span>
  );

  const showBuiltin = tab === 'builtin';
  const isSearching = search.trim().length > 0;
  const { folders: subfolders, files: folderFiles } = folderContents(customIcons, folder);
  const visibleFolderFiles = folderFiles.slice(0, MAX_VISIBLE);
  const customEmpty = isSearching
    ? visibleCustom.length === 0
    : subfolders.length === 0 && visibleFolderFiles.length === 0;
  const confirmTopMatch = () => {
    if (showBuiltin) {
      const icon = visibleBuiltin[0];
      if (icon) handleConfirm({ type: 'builtin', name: icon.id });
      return;
    }
    if (!isSearching) return;
    const icon = visibleCustom[0];
    if (icon) handleConfirm({ type: 'custom', path: icon.path });
  };

  return (
    <AssetPickerShell
      title={target?.label}
      action="Select icon"
      compact
      onClose={close}
      onConfirm={() => handleConfirm()}
      confirmDisabled={!selected}
      tabs={tabs}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={confirmTopMatch}
      searchPlaceholder="Search icons…"
      countLabel={countLabel}
      loading={loading}
      loadError={loadError}
      errorPrefix="custom icons"
      selectionPreview={selectionPreview}
    >
      {showBuiltin ? (
        visibleBuiltin.length === 0 ? (
          <p className="cfg-asset-picker-empty">No icons match your search.</p>
        ) : (
          <div className="cfg-asset-picker-grid">
            {visibleBuiltin.map((icon) => {
              const IconComp = BUILTIN_ICON_COMPONENTS[icon.id];
              if (!IconComp) return null;
              return (
                <button
                  key={icon.id}
                  title={icon.label}
                  className={`cfg-asset-picker-icon-btn${selName === icon.id ? ' cfg-asset-picker-icon-btn--selected' : ''}`}
                  type="button"
                  onClick={() => setSelected({ type: 'builtin', name: icon.id })}
                  onDoubleClick={() => handleConfirm({ type: 'builtin', name: icon.id })}
                >
                  <IconComp size={20} weight="regular" />
                </button>
              );
            })}
          </div>
        )
      ) : (
        <>
          {!isSearching && folder && <FolderBreadcrumb folder={folder} onNavigate={setFolder} />}
          {customEmpty ? (
            <p className="cfg-asset-picker-empty">
              {isSearching
                ? 'No icons match your search.'
                : customIcons.length === 0
                  ? "No custom icons found. Place SVG files in the project's assets/icons/."
                  : 'This folder is empty.'}
            </p>
          ) : isSearching ? (
            <div className="cfg-asset-picker-grid">
              {visibleCustom.map((item) => (
                <button
                  key={item.path}
                  title={item.path}
                  className={`cfg-asset-picker-icon-btn${selPath === item.path ? ' cfg-asset-picker-icon-btn--selected' : ''}`}
                  type="button"
                  onClick={() => setSelected({ type: 'custom', path: item.path })}
                  onDoubleClick={() => handleConfirm({ type: 'custom', path: item.path })}
                >
                  <img src={assetUrl(item.path)} alt={item.name} width={20} height={20} />
                </button>
              ))}
            </div>
          ) : (
            <>
              {subfolders.length > 0 && (
                <div className="cfg-asset-picker-folder-row">
                  {subfolders.map((name) => (
                    <button
                      key={name}
                      title={name}
                      className="cfg-asset-picker-folder-btn cfg-asset-picker-folder-btn--icon"
                      type="button"
                      onClick={() => setFolder(folder ? `${folder}/${name}` : name)}
                    >
                      <FolderSimple size={20} weight="fill" />
                      <span className="cfg-asset-picker-folder-btn__name">{name}</span>
                    </button>
                  ))}
                </div>
              )}
              {subfolders.length > 0 && visibleFolderFiles.length > 0 && (
                <hr className="cfg-asset-picker-divider" />
              )}
              {visibleFolderFiles.length > 0 && (
                <div className="cfg-asset-picker-grid">
                  {visibleFolderFiles.map((item) => (
                    <button
                      key={item.path}
                      title={item.path}
                      className={`cfg-asset-picker-icon-btn${selPath === item.path ? ' cfg-asset-picker-icon-btn--selected' : ''}`}
                      type="button"
                      onClick={() => setSelected({ type: 'custom', path: item.path })}
                      onDoubleClick={() => handleConfirm({ type: 'custom', path: item.path })}
                    >
                      <img src={assetUrl(item.path)} alt={item.name} width={20} height={20} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </AssetPickerShell>
  );
}
