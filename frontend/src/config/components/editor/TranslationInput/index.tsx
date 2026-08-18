/**
 * TranslationInput — compound widget for string schema fields.
 *
 * Provides a tiny mode toggle (P / T) between plain text and translation.
 * When a translation is selected, it's shown as a tag/badge.
 * When in Translation mode and no match is found, an "Add" button lets the
 * user create a new translation entry on the fly.
 *
 * Value encoding:
 *   - Plain text:  a simple string
 *   - Translation:  { "$loc": "translation-key" }
 */

import './style.css';
import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import { isLocSource } from '@shared/types/propertyValueGuards';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';
import { matchesSearchWords } from '@shared/utils/search';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import { FieldActions } from '@config/components/ui/FieldGroup';
import { ClearIcon, TranslateIcon } from '@config/components/ui/actionIcons';
import TranslationValuesPopover from './TranslationValuesPopover';
import { computeAnchoredPosition } from './anchoredPosition';

interface TranslationInputProps {
  value: unknown;
  onChange: (v: unknown) => void;
  translationOnly?: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TranslationInput({
  value,
  onChange,
  translationOnly = false,
}: TranslationInputProps) {
  const translations = useTranslationStore((s) => s.translations);
  const languages = useTranslationStore((s) => s.languages);
  const addTranslation = useTranslationStore((s) => s.addTranslation);
  const resolve = useTranslationStore((s) => s.resolve);

  const isTranslation = isLocSource(value);

  const [mode, setMode] = useState<'plain' | 'translation'>(
    translationOnly || isTranslation ? 'translation' : 'plain',
  );

  // Searchable dropdown state
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const keys = useMemo(
    () => Object.keys(translations).sort((a, b) => a.localeCompare(b)),
    [translations],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return keys;
    return keys.filter((key) =>
      matchesSearchWords(search, [key, ...Object.values(translations[key])]),
    );
  }, [keys, search, translations]);

  const hasExactMatch = useMemo(
    () => keys.some((k) => k.toLowerCase() === search.toLowerCase()),
    [keys, search],
  );

  useEffect(() => {
    if (!translationOnly) return;
    setMode('translation');
    if (isLocSource(value)) {
      setSearch(value.$loc);
    }
  }, [translationOnly, value]);

  // Close dropdown when clicking outside; revert to plain if nothing selected
  useDismissOnOutsideClick(wrapperRef, () => {
    setOpen(false);
    if (!translationOnly && !isLocSource(value)) {
      setMode('plain');
    }
  });

  // The values popover owns the field while it is open — the key dropdown would
  // otherwise reopen behind it whenever focus returns to the search input.
  useEffect(() => {
    if (editing) setOpen(false);
  }, [editing]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const repositionDropdown = useCallback(() => {
    const anchor = searchWrapperRef.current;
    const dropdown = listRef.current;
    if (!anchor || !dropdown) return;

    const anchorRect = anchor.getBoundingClientRect();
    const width = Math.max(400, anchorRect.width);
    const pos = computeAnchoredPosition(anchorRect, anchorRect.right - width, width, 200);

    dropdown.style.position = 'fixed';
    dropdown.style.left = `${pos.left}px`;
    dropdown.style.right = 'auto';
    dropdown.style.width = `${pos.width}px`;
    dropdown.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
    dropdown.style.maxHeight = `${Math.min(300, pos.maxHeight)}px`;
    dropdown.style.top = pos.top !== undefined ? `${pos.top}px` : 'auto';
    dropdown.style.bottom = pos.bottom !== undefined ? `${pos.bottom}px` : 'auto';
  }, []);

  useLayoutEffect(() => {
    if (open) repositionDropdown();
  }, [open, repositionDropdown]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', repositionDropdown, true);
    window.addEventListener('resize', repositionDropdown);
    return () => {
      window.removeEventListener('scroll', repositionDropdown, true);
      window.removeEventListener('resize', repositionDropdown);
    };
  }, [open, repositionDropdown]);

  function toggleMode() {
    const newMode = mode === 'plain' ? 'translation' : 'plain';
    setMode(newMode);
    if (newMode === 'plain') {
      if (isLocSource(value)) {
        onChange(resolve(value.$loc));
      }
    } else {
      if (typeof value === 'string' && value in translations) {
        onChange({ $loc: value });
      } else {
        setSearch('');
        setOpen(true);
      }
    }
  }

  function selectKey(key: string) {
    onChange({ $loc: key });
    setSearch('');
    setOpen(false);
    setActiveIndex(-1);
  }

  async function handleAdd() {
    const trimmed = search.trim();
    if (!trimmed) return;
    await addTranslation(trimmed);
    onChange({ $loc: trimmed });
    setSearch('');
    setOpen(false);
  }

  function clearSelection() {
    setSearch('');
    setOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const index = activeIndex >= 0 && activeIndex < filtered.length ? activeIndex : 0;
      if (filtered.length > 0) {
        selectKey(filtered[index]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      if (!translationOnly && !isLocSource(value)) {
        setMode('plain');
      }
    }
  }

  const modeClass = mode === 'translation' ? 'cfg-toggle-mode--accent' : 'cfg-toggle-mode--plain';

  const actionButtonClass = translationOnly
    ? 'cfg-row-action-btn cfg-row-action-btn--stretch'
    : 'editor-prop-translation__edit-btn';

  const editButton = (
    <button
      ref={editButtonRef}
      className={actionButtonClass}
      type="button"
      title="Edit translations"
      onClick={() => {
        if (!editing) setOpen(false);
        setEditing(!editing);
      }}
    >
      <TranslateIcon />
    </button>
  );

  const clearButton = (
    <button
      className={actionButtonClass}
      type="button"
      title="Clear"
      onClick={() => {
        setSearch('');
        setOpen(false);
        onChange(undefined);
      }}
    >
      <ClearIcon />
    </button>
  );

  return (
    <div className="editor-prop-translation" ref={wrapperRef}>
      <div className="editor-prop-translation__row">
        {!translationOnly && (
          <button
            className={`cfg-toggle-mode ${modeClass}`}
            type="button"
            onClick={toggleMode}
            title={
              mode === 'plain'
                ? 'Plain text — click for Translation'
                : 'Translation — click for Plain text'
            }
          >
            {mode === 'plain' ? 'P' : 'T'}
          </button>
        )}

        {mode === 'plain' ? (
          <input
            className="cfg-prop-input"
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <div className="editor-prop-translation__search-wrapper" ref={searchWrapperRef}>
            {isTranslation && !open && !translationOnly ? (
              <span
                className="cfg-tag cfg-text-truncate editor-prop-translation__tag"
                onClick={clearSelection}
                title={languages
                  .map(
                    (l, index) =>
                      `${l.code}: ${index === 0 ? value.$loc : (translations[value.$loc]?.[l.code] ?? '')}`,
                  )
                  .join('\n')}
              >
                {value.$loc}
              </span>
            ) : (
              <input
                className="cfg-prop-input cfg-prop-input--translation"
                type="text"
                value={search}
                placeholder="Search translations…"
                autoFocus={open && !search}
                onFocus={() => {
                  if (!editing) setOpen(true);
                }}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (!editing) setOpen(true);
                  setActiveIndex(-1);
                }}
                onKeyDown={handleKeyDown}
              />
            )}
            {open &&
              createPortal(
                <ul
                  className="cfg-select-popup editor-prop-translation__dropdown"
                  ref={listRef}
                  role="listbox"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {filtered.map((key, i) => {
                    const translatedValues = Object.entries(translations[key]).filter(
                      ([, translatedValue]) => translatedValue && translatedValue !== key,
                    );

                    return (
                      <li
                        key={key}
                        className={
                          'cfg-select-popup__option' +
                          (i === activeIndex ? ' cfg-select-popup__option--active' : '') +
                          (isTranslation && value.$loc === key
                            ? ' cfg-select-popup__option--selected'
                            : '')
                        }
                        role="option"
                        aria-selected={isTranslation && value.$loc === key}
                        onMouseEnter={() => setActiveIndex(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectKey(key)}
                      >
                        <span className="editor-prop-translation__option-key">
                          <SearchHighlight text={key} query={search} />
                        </span>
                        {translatedValues.length > 0 && (
                          <span className="editor-prop-translation__option-values">
                            {translatedValues.map(([languageCode, translatedValue]) => (
                              <span
                                className="editor-prop-translation__option-value"
                                key={languageCode}
                              >
                                <span className="editor-prop-translation__option-language">
                                  {languageCode}
                                </span>
                                <span className="editor-prop-translation__option-text">
                                  <SearchHighlight text={translatedValue} query={search} />
                                </span>
                              </span>
                            ))}
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {search.trim() && !hasExactMatch && (
                    <li
                      className="cfg-select-popup__option editor-prop-translation__add"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleAdd}
                    >
                      + Add &ldquo;{search.trim()}&rdquo;
                    </li>
                  )}
                  {filtered.length === 0 && !(search.trim() && !hasExactMatch) && (
                    <li className="editor-prop-translation__empty">No translations found</li>
                  )}
                </ul>,
                document.body,
              )}
          </div>
        )}

        {mode === 'translation' && !translationOnly && isTranslation && (
          <>
            {value.$loc in translations && editButton}
            {clearButton}
          </>
        )}
      </div>
      {mode === 'translation' && translationOnly && isTranslation && (
        <FieldActions>
          {value.$loc in translations && editButton}
          {clearButton}
        </FieldActions>
      )}
      {editing &&
        isTranslation &&
        value.$loc in translations &&
        createPortal(
          <TranslationValuesPopover
            translationKey={value.$loc}
            anchorRef={wrapperRef}
            triggerRef={editButtonRef}
            onClose={() => setEditing(false)}
          />,
          document.body,
        )}
    </div>
  );
}
