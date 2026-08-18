import './style.css';
import { useEffect, useRef } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';

interface TreeToggleButtonProps {
  open: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

interface TreeRowActionButtonProps {
  title: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

export function TreeToggleButton({ open, onClick }: TreeToggleButtonProps) {
  return (
    <button className="cfg-tree-toggle cfg-icon-reset cfg-inline-flex-center" onClick={onClick}>
      <span className={`cfg-tree-toggle__arrow${open ? ' cfg-tree-toggle__arrow--open' : ''}`}>
        ▶
      </span>
    </button>
  );
}

export function TreeRowActionButton({ title, onClick, children }: TreeRowActionButtonProps) {
  return (
    <button
      className="cfg-tree-item__row-btn cfg-tree-row-action cfg-inline-flex-center"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface TreeDiagnosticDotProps {
  severity: 'error' | 'warning';
  /** What the dot stands for, e.g. "2 errors inside Sidebar". */
  title: string;
}

/**
 * Severity dot on a tree row — the tree's counterpart to the property panel's
 * field badge, so a broken widget is findable without selecting it first.
 * Rows roll their descendants up, so a collapsed branch still shows the mark.
 */
export function TreeDiagnosticDot({ severity, title }: TreeDiagnosticDotProps) {
  return (
    <span
      className={`cfg-tree-item__diag cfg-tree-item__diag--${severity}`}
      role="img"
      aria-label={title}
      title={title}
    />
  );
}

interface TreeRenameInputProps {
  /** Item id; rename input shows when this matches `editingId`. */
  id: string;
  /** Currently-editing id, or null when nothing is in rename mode. */
  editingId: string | null;
  /** Draft title bound to the input. */
  draft: string;
  onChange: (value: string) => void;
  /** Called on Enter, Escape, or blur — caller decides commit vs cancel. */
  onCommit: (id: string) => void;
  /** Static label rendered when this row isn't being edited. */
  label: ReactNode;
}

/**
 * Inline tree-row rename: shows a focused input with the same Enter/Escape/blur
 * behaviour everywhere a tree item is editable, and falls back to the row's
 * static label when not in rename mode.
 */
export function TreeRenameInput({
  id,
  editingId,
  draft,
  onChange,
  onCommit,
  label,
}: TreeRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isEditing = editingId === id;

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  if (!isEditing) {
    return <span className="cfg-tree-item__label">{label}</span>;
  }

  return (
    <input
      ref={inputRef}
      className="cfg-tree-item__rename-input"
      value={draft}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') onCommit(id);
      }}
      onBlur={() => onCommit(id)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}
