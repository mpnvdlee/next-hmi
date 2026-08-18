import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { isEditableTarget } from '@shared/utils/domEvent';
import './style.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  width?: number | string;
  /** `header` keeps a toolbar's fixed width; `fill` stretches to its flex row. */
  variant?: 'header' | 'fill';
  /** Suspends the `/` shortcut while an overlay owns the key. */
  shortcutDisabled?: boolean;
}

const HeaderSearch = forwardRef<HTMLInputElement, Props>(function HeaderSearch(
  {
    value,
    onChange,
    onEnter,
    placeholder = 'Search…',
    ariaLabel = 'Search',
    width,
    variant = 'header',
    shortcutDisabled = false,
  },
  forwardedRef,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current!, []);

  useEffect(() => {
    if (shortcutDisabled) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key !== '/' || isEditableTarget(event.target)) return;
      event.preventDefault();
      // Defer focus to the next frame — focusing synchronously here can still
      // leak the "/" keystroke into the newly-focused input in some browsers.
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [shortcutDisabled]);

  return (
    <div
      className={
        variant === 'fill'
          ? 'cfg-tree__search-field cfg-header-search cfg-header-search--fill'
          : 'cfg-tree__search-field cfg-header-search cfg-header-control'
      }
      style={width ? { width } : undefined}
    >
      <MagnifyingGlass
        className="cfg-tree__search-icon"
        size={16}
        weight="bold"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="search"
        className="cfg-tree__search-input"
        aria-label={ariaLabel}
        aria-keyshortcuts={shortcutDisabled ? undefined : '/'}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onEnter) {
            event.preventDefault();
            onEnter();
          } else if (event.key === 'Escape') {
            onChange('');
            event.currentTarget.blur();
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="cfg-tree__search-clear"
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          title="Clear search"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <X size={14} weight="bold" aria-hidden="true" />
        </button>
      ) : (
        <kbd className="cfg-tree__search-shortcut" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
});

export default HeaderSearch;
