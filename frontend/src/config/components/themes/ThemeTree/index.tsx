/**
 * ThemeTree — left sidebar for ThemesView.
 *
 * A collapsible "Themes" root node with a count badge and an add (+) button,
 * then a flat list of theme leaves. Select to edit in the main panel; the
 * context menu sets the default, duplicates, or deletes. Uses the shared
 * cfg-tree* classes and TreeAffordances matching AlarmTree / UsersTree.
 */

import { useState } from 'react';
import { Palette, Star } from '@phosphor-icons/react';
import { ContextMenu, ContextMenuItem } from '../../ui/ContextMenu';
import { TreeRowActionButton } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import NameInputModal from '../../ui/NameInputModal';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';
import { useThemeViewStore } from '@config/store/themeViewStore';

export default function ThemeTree() {
  const themeIds = useThemeViewStore((s) => s.themeIds);
  const selectedThemeId = useThemeViewStore((s) => s.selectedThemeId);
  const defaultThemeId = useThemeViewStore((s) => s.defaultThemeId);
  const select = useThemeViewStore((s) => s.select);
  const createTheme = useThemeViewStore((s) => s.createTheme);
  const deleteTheme = useThemeViewStore((s) => s.deleteTheme);
  const setDefaultTheme = useThemeViewStore((s) => s.setDefaultTheme);

  const [expanded, setExpanded] = useState(true);
  const [adding, setAdding] = useState(false);
  const [duplicatingFrom, setDuplicatingFrom] = useState<string | null>(null);

  const rootMenu = useContextMenu();
  const itemMenu = useContextMenu<{ id: string }>();
  const deleteConfirm = useDeleteConfirm<{ id: string }>({
    message: (t) => `Delete theme "${t.id}"? This cannot be undone.`,
    onConfirm: (t) => void deleteTheme(t.id),
  });

  function handleAddClick(e: React.MouseEvent) {
    e.stopPropagation();
    rootMenu.close();
    setAdding(true);
  }

  return (
    <div className="cfg-tree">
      <div className="cfg-tree__scroll">
        {/* ── THEMES root node ── */}
        <TreeRow
          variant="group"
          toggle={{ open: expanded, onClick: () => setExpanded((v) => !v) }}
          icon={<Palette size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />}
          label={<span className="cfg-tree-item__label">Themes</span>}
          onSelect={() => setExpanded((v) => !v)}
          onContextMenu={(e) => rootMenu.open(e, {})}
        >
          <span className="cfg-tree-item__count">{themeIds.length}</span>
          <TreeRowActionButton title="Add theme" onClick={handleAddClick}>
            +
          </TreeRowActionButton>
        </TreeRow>

        {expanded && (
          <>
            {themeIds.map((id) => (
              <TreeRow
                key={id}
                depth={1}
                selected={id === selectedThemeId}
                icon={
                  <Palette size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />
                }
                label={<span className="cfg-tree-item__label">{id}</span>}
                onSelect={() => select(id)}
                onContextMenu={(e) => itemMenu.open(e, { id })}
              >
                {id === defaultThemeId && (
                  <span className="cfg-tree-item__count" title="Default theme">
                    <Star size={12} weight="fill" color="var(--cfg-accent)" />
                  </span>
                )}
                {themeIds.length > 1 && (
                  <TreeRowActionButton
                    title={`Delete ${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConfirm.ask({ id });
                    }}
                  >
                    ×
                  </TreeRowActionButton>
                )}
              </TreeRow>
            ))}

            {themeIds.length === 0 && (
              <div className="cfg-tree-section-empty">No themes. Click + to add one.</div>
            )}
          </>
        )}
      </div>

      {rootMenu.state && (
        <ContextMenu x={rootMenu.state.x} y={rootMenu.state.y} onClose={rootMenu.close}>
          <ContextMenuItem
            onClick={() => {
              rootMenu.close();
              setAdding(true);
            }}
          >
            Add Theme…
          </ContextMenuItem>
        </ContextMenu>
      )}

      {itemMenu.state && (
        <ContextMenu x={itemMenu.state.x} y={itemMenu.state.y} onClose={itemMenu.close}>
          {itemMenu.state.id !== defaultThemeId && (
            <ContextMenuItem
              onClick={() => {
                void setDefaultTheme(itemMenu.state!.id);
                itemMenu.close();
              }}
            >
              Set as default
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() => {
              setDuplicatingFrom(itemMenu.state!.id);
              itemMenu.close();
            }}
          >
            Duplicate…
          </ContextMenuItem>
          {themeIds.length > 1 && (
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({ id: itemMenu.state!.id });
                itemMenu.close();
              }}
            >
              Delete "{itemMenu.state.id}"…
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}

      {adding && (
        <NameInputModal
          title="New Theme"
          placeholder="Theme name…"
          onConfirm={(name) => {
            void createTheme(name);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {duplicatingFrom && (
        <NameInputModal
          title={`Duplicate "${duplicatingFrom}"`}
          placeholder="New theme name…"
          onConfirm={(name) => {
            void createTheme(name, duplicatingFrom);
            setDuplicatingFrom(null);
          }}
          onCancel={() => setDuplicatingFrom(null)}
        />
      )}

      {deleteConfirm.modal}
    </div>
  );
}
