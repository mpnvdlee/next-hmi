/**
 * TranslationValuesPopover — compact popover, anchored under the translation
 * field, for editing the per-language texts of the selected key. The key itself
 * (primary language column) stays immutable; confirmed edits go into the
 * translation draft and persist with the normal project save.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import Button from '@config/components/ui/Button';
import { useTranslationStore } from '@shared/store/translationStore';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';
import { computeAnchoredPosition } from './anchoredPosition';
import { useOwnerWindow } from '@shared/components/PopoutWindow/windowContext';

interface Props {
  translationKey: string;
  anchorRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  onClose(): void;
}

export default function TranslationValuesPopover({
  translationKey,
  anchorRef,
  triggerRef,
  onClose,
}: Props) {
  const ownerWindow = useOwnerWindow();
  const languages = useTranslationStore((s) => s.languages);
  const updateCell = useTranslationStore((s) => s.updateCell);
  const stored = useTranslationStore((s) => s.translations[translationKey]);

  const popoverRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const primaryCode = languages[0]?.code;
  const secondary = languages.filter((language) => language.code !== primaryCode);

  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(secondary.map((language) => [language.code, stored?.[language.code] ?? ''])),
  );

  const confirm = useCallback(() => {
    for (const language of secondary) {
      const next = draft[language.code] ?? '';
      if (next !== (stored?.[language.code] ?? '')) updateCell(translationKey, language.code, next);
    }
    onClose();
  }, [draft, onClose, secondary, stored, translationKey, updateCell]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    // Align the inputs — not the popover surface — with the anchored property
    // field, so the fields read as one column.
    const style = getComputedStyle(popover);
    const insetLeft = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    const insetRight = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);

    const anchorRect = anchor.getBoundingClientRect();
    const pos = computeAnchoredPosition(
      anchorRect,
      anchorRect.left - insetLeft,
      anchorRect.width + insetLeft + insetRight,
      popover.offsetHeight,
      ownerWindow,
    );

    popover.style.left = `${pos.left}px`;
    popover.style.width = `${pos.width}px`;
    popover.style.top = pos.top !== undefined ? `${pos.top}px` : 'auto';
    popover.style.bottom = pos.bottom !== undefined ? `${pos.bottom}px` : 'auto';
  }, [anchorRef, ownerWindow]);

  useLayoutEffect(reposition, [reposition]);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    ownerWindow.addEventListener('keydown', onKeyDown);
    ownerWindow.addEventListener('scroll', reposition, true);
    ownerWindow.addEventListener('resize', reposition);
    return () => {
      ownerWindow.removeEventListener('keydown', onKeyDown);
      ownerWindow.removeEventListener('scroll', reposition, true);
      ownerWindow.removeEventListener('resize', reposition);
    };
  }, [onClose, reposition, ownerWindow]);

  const triggerRefs = useMemo(() => [triggerRef], [triggerRef]);
  useDismissOnOutsideClick(popoverRef, onClose, true, triggerRefs);

  return (
    <div className="editor-prop-translation__values" ref={popoverRef}>
      {primaryCode && (
        <div className="editor-prop-translation__values-row">
          <span className="editor-prop-translation__values-lang">{primaryCode}</span>
          <span
            className="editor-prop-translation__values-key"
            title="The primary translation value is the immutable lookup key."
          >
            {translationKey}
          </span>
        </div>
      )}
      {secondary.map((language, index) => (
        <label key={language.code} className="editor-prop-translation__values-row">
          <span className="editor-prop-translation__values-lang">{language.code}</span>
          <input
            ref={index === 0 ? firstInputRef : undefined}
            className="cfg-prop-input"
            type="text"
            value={draft[language.code] ?? ''}
            placeholder={translationKey}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [language.code]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirm();
              }
            }}
          />
        </label>
      ))}
      {secondary.length === 0 && (
        <p className="cfg-prop-hint">
          No other languages yet. Add language columns on the Translations page.
        </p>
      )}
      <div className="editor-prop-translation__values-actions">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={confirm}>
          Confirm
        </Button>
      </div>
    </div>
  );
}
