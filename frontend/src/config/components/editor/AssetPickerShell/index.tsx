/**
 * AssetPickerShell — shared chrome for right-side asset-picker drawers
 * (IconSourcePicker, ImageSourcePicker).
 *
 * Wraps ModalShell (overlay + dialog + Escape) and adds: header, optional
 * tab strip, search row with optional count, loading / error states,
 * scrollable body slot and footer with selection preview + Cancel/Confirm.
 *
 * Enter confirms from the search field or any non-editable control.
 */

import { useRef, type ReactNode } from 'react';
import ModalShell from '@config/components/ui/ModalShell';
import PickerDrawerHeader, { PickerTitle } from '@config/components/ui/PickerDrawerHeader';
import PickerFooter from '@config/components/ui/PickerFooter';
import { useConfirmOnEnter } from '@shared/hooks/useConfirmOnEnter';
import { ContentSpinner } from '@shared/components/Spinner';
import './style.css';

interface AssetPickerShellProps {
  /** What the asset is for — the property being set. */
  title?: string;
  /** What is being picked: "Select icon", "Select image". */
  action: string;
  /** Use a narrower drawer for compact pickers such as the icon grid. */
  compact?: boolean;

  onClose: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;

  /** Optional rendered tab strip placed below the header. */
  tabs?: ReactNode;

  search: string;
  onSearchChange: (value: string) => void;
  /** Optional Enter action for the search field (for example, pick its top result). */
  onSearchEnter?: () => void;
  searchPlaceholder?: string;
  /** Optional badge shown to the right of the search input (e.g. "200 of 412"). */
  countLabel?: ReactNode;

  loading?: boolean;
  loadError?: string | null;
  /** Prefix for the error message ("Failed to load <prefix>: …"). */
  errorPrefix?: string;

  /** Footer content shown left of the action buttons (selection preview). */
  selectionPreview: ReactNode;

  /**
   * Body content. Only rendered when not loading and there's no load error;
   * the shell renders the loading and error states itself.
   */
  children: ReactNode;
}

export default function AssetPickerShell({
  title,
  action,
  compact = false,
  onClose,
  onConfirm,
  confirmDisabled,
  tabs,
  search,
  onSearchChange,
  onSearchEnter,
  searchPlaceholder = 'Search…',
  countLabel,
  loading,
  loadError,
  errorPrefix,
  selectionPreview,
  children,
}: AssetPickerShellProps) {
  useConfirmOnEnter(onConfirm, confirmDisabled);
  const searchInputRef = useRef<HTMLInputElement>(null);

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName="cfg-asset-picker-overlay cfg-picker-drawer-overlay"
      dialogClassName={`cfg-drawer cfg-drawer--${compact ? 'sm' : 'md'} cfg-asset-picker-dialog`}
      initialFocusRef={searchInputRef}
    >
      <PickerDrawerHeader
        className="cfg-asset-picker-header"
        title={<PickerTitle context={title} action={action} />}
        search={search}
        onSearchChange={onSearchChange}
        onSearchEnter={onSearchEnter ?? (confirmDisabled ? undefined : onConfirm)}
        searchAriaLabel={`Search ${action.toLowerCase()}`}
        searchPlaceholder={searchPlaceholder}
        searchInputRef={searchInputRef}
        meta={countLabel}
        onClose={onClose}
      />

      {tabs}

      <div className="cfg-asset-picker-grid-wrap">
        {loading && <ContentSpinner variant="cfg" />}

        {!loading && loadError && (
          <p className="cfg-asset-picker-empty cfg-asset-picker-error">
            {errorPrefix ? `Failed to load ${errorPrefix}: ` : ''}
            {loadError}
          </p>
        )}

        {!loading && !loadError && children}
      </div>

      <PickerFooter
        preview={selectionPreview}
        onCancel={onClose}
        onConfirm={onConfirm}
        confirmDisabled={confirmDisabled}
      />
    </ModalShell>
  );
}
