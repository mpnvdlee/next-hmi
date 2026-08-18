/**
 * BindingPickerShell — shared chrome for right-side binding-picker drawers.
 *
 * Wraps ModalShell (overlay + dialog + Escape) and adds: header (title +
 * optional subtitle + ×), body layout (tree-left / detail-right), search
 * input, optional "show all" checkbox, error banner, scrollable list
 * container, and footer action buttons.
 *
 * Enter confirms only when focus is outside the search input — typing in
 * search never triggers an accidental confirm.
 */

import './style.css';
import { useRef, type ReactNode, type RefObject } from 'react';
import ModalShell from '@config/components/ui/ModalShell';
import PickerDrawerHeader, { PickerTitle } from '@config/components/ui/PickerDrawerHeader';
import PickerFooter from '@config/components/ui/PickerFooter';
import { useConfirmOnEnter } from '@shared/hooks/useConfirmOnEnter';

interface BindingPickerShellProps {
  /** What the binding is for — the property being bound. */
  title: string;
  /** What is being picked: "Select binding", "Select property". */
  action: string;
  /** Optional secondary line shown next to the title. */
  subtitle?: string;

  onClose: () => void;
  onConfirm: () => void;
  /** When omitted, the Clear button is hidden. */
  onClear?: () => void;

  /** Disables the Confirm button (and the Enter shortcut) when true. */
  confirmDisabled?: boolean;

  search: string;
  onSearchChange: (value: string) => void;
  /** Optional Enter action for the search field (for example, confirm its top result). */
  onSearchEnter?: () => void;
  searchPlaceholder?: string;

  /** Whether to render the "show all" checkbox at all */
  showAllCheckbox?: boolean;
  showAll?: boolean;
  onShowAllChange?: (checked: boolean) => void;

  loadError?: string | null;

  /** Ref forwarded to <div className="editor-binding-list"> (needed by virtualizer) */
  listRef: RefObject<HTMLDivElement | null>;

  /** Tree/list rows rendered inside the scrollable list container */
  listContent: ReactNode;

  /** Right-column content (detail panels, requirements, etc.) */
  rightPanel?: ReactNode;
}

export default function BindingPickerShell({
  title,
  action,
  subtitle,
  onClose,
  onConfirm,
  onClear,
  confirmDisabled,
  search,
  onSearchChange,
  onSearchEnter,
  searchPlaceholder = 'Search…',
  showAllCheckbox,
  showAll,
  onShowAllChange,
  loadError,
  listRef,
  listContent,
  rightPanel,
}: BindingPickerShellProps) {
  useConfirmOnEnter(onConfirm, confirmDisabled);
  const searchInputRef = useRef<HTMLInputElement>(null);

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName="editor-binding-overlay cfg-picker-drawer-overlay"
      dialogClassName="cfg-drawer cfg-drawer--lg editor-binding-dialog"
      initialFocusRef={searchInputRef}
    >
      <PickerDrawerHeader
        className="editor-binding-header"
        title={<PickerTitle context={title} action={action} />}
        subtitle={subtitle && <span className="editor-binding-header__sub">{subtitle}</span>}
        search={search}
        onSearchChange={onSearchChange}
        onSearchEnter={onSearchEnter}
        searchAriaLabel={`Search ${title}`}
        searchPlaceholder={searchPlaceholder}
        searchInputRef={searchInputRef}
        meta={
          showAllCheckbox && (
            <label className="editor-binding-showall">
              <input
                type="checkbox"
                checked={!!showAll}
                onChange={(e) => onShowAllChange?.(e.target.checked)}
              />
              Show all
            </label>
          )
        }
        onClose={onClose}
      />

      <div className="editor-binding-body">
        <div className="editor-binding-left">
          {loadError && <div className="cfg-error-banner">{loadError}</div>}
          <div className="editor-binding-list" ref={listRef}>
            {listContent}
          </div>
        </div>

        {rightPanel}
      </div>

      <PickerFooter
        destructive={onClear ? { label: 'Clear binding', onClick: onClear } : undefined}
        onCancel={onClose}
        onConfirm={onConfirm}
        confirmDisabled={confirmDisabled}
      />
    </ModalShell>
  );
}
