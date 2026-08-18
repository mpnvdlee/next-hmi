import { useState } from 'react';
import { ContextMenu, ContextMenuItem } from '../../ui/ContextMenu';
import { TreeRowActionButton } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import { useContextMenu } from '@config/hooks/useContextMenu';

interface Props {
  dictionaries: string[];
  active: string;
  onSelect(name: string): void;
  onAdd(): void;
  onDelete(name: string): void;
}

export default function DictionaryTree({ dictionaries, active, onSelect, onAdd, onDelete }: Props) {
  const [expanded, setExpanded] = useState(true);
  const menu = useContextMenu<{ name: string | null }>();

  return (
    <div className="cfg-tree">
      <div className="cfg-tree__scroll">
        {/* Root group row — same item style but bold */}
        <TreeRow
          variant="group"
          toggle={{ open: expanded, onClick: () => setExpanded((v) => !v) }}
          icon={
            <svg
              className="cfg-tree-item__icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M1 5.5A1.5 1.5 0 0 1 2.5 4h3.086a1 1 0 0 1 .707.293L7.707 5.7A1 1 0 0 0 8.414 6H13.5A1.5 1.5 0 0 1 15 7.5v5A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-7z" />
            </svg>
          }
          label={<span className="cfg-tree-item__label">Dictionaries</span>}
          onSelect={() => setExpanded((v) => !v)}
          onContextMenu={(e) => menu.open(e, { name: null })}
        >
          <span className="cfg-tree-item__count">{dictionaries.length}</span>
          <TreeRowActionButton
            title="New dictionary"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            +
          </TreeRowActionButton>
        </TreeRow>

        {/* Child items */}
        {expanded &&
          dictionaries.map((name) => (
            <TreeRow
              key={name}
              depth={1}
              selected={active === name}
              icon={
                <svg
                  className="cfg-tree-item__icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M1 5.5A1.5 1.5 0 0 1 2.5 4h3.086a1 1 0 0 1 .707.293L7.707 5.7A1 1 0 0 0 8.414 6H13.5A1.5 1.5 0 0 1 15 7.5v5A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-7z" />
                </svg>
              }
              label={<span className="cfg-tree-item__label">{name}</span>}
              onSelect={() => onSelect(name)}
              onContextMenu={(e) => menu.open(e, { name })}
            />
          ))}
      </div>

      {menu.state && (
        <ContextMenu x={menu.state.x} y={menu.state.y} onClose={menu.close}>
          {menu.state.name === null ? (
            <ContextMenuItem
              onClick={() => {
                menu.close();
                onAdd();
              }}
            >
              New Dictionary…
            </ContextMenuItem>
          ) : menu.state.name === 'Default' ? (
            <span className="cfg-context-menu__item cfg-context-menu__item--empty">
              No actions available
            </span>
          ) : (
            <ContextMenuItem
              danger
              onClick={() => {
                onDelete(menu.state!.name!);
                menu.close();
              }}
            >
              Delete "{menu.state.name}"…
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
