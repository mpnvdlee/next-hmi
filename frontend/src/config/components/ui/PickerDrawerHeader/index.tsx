import { type ReactNode, type RefObject } from 'react';
import { ModalCloseButton } from '../ModalShell';
import HeaderSearch from '../HeaderSearch';

interface PickerTitleProps {
  /** What the pick is for — the property, the container, the component. */
  context?: ReactNode;
  /** What is being picked: "Select binding", "Add widget", … */
  action: string;
}

/** `context › action` drawer title, shared by every picker. */
export function PickerTitle({ context, action }: PickerTitleProps) {
  return (
    <h2 className="cfg-picker-title">
      {context ? (
        <>
          <span className="cfg-picker-title__context">{context}</span>
          <span className="cfg-picker-title__sep" aria-hidden="true">
            ›
          </span>
        </>
      ) : null}
      <span className="cfg-picker-title__action">{action}</span>
    </h2>
  );
}

interface PickerDrawerHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  onSearchEnter?: () => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Filter toggles / counts, shown in the row before the search input. */
  meta?: ReactNode;
  onClose: () => void;
  className?: string;
}

/** Shared header chrome for searchable picker drawers. */
export default function PickerDrawerHeader({
  title,
  subtitle,
  search,
  onSearchChange,
  onSearchEnter,
  searchPlaceholder,
  searchAriaLabel,
  searchInputRef,
  meta,
  onClose,
  className = '',
}: PickerDrawerHeaderProps) {
  return (
    <div className={`cfg-modal-header cfg-picker-drawer-header ${className}`.trim()}>
      <div className="cfg-picker-drawer-header__info">
        {title}
        {subtitle}
      </div>
      <div className="cfg-picker-drawer-header__search">
        {meta}
        <HeaderSearch
          ref={searchInputRef}
          value={search}
          onChange={onSearchChange}
          onEnter={onSearchEnter}
          ariaLabel={searchAriaLabel}
          placeholder={searchPlaceholder}
        />
      </div>
      <ModalCloseButton onClose={onClose} />
    </div>
  );
}
