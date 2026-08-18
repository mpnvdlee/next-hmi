import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

/**
 * State machine for a text input that free-types over a committed domain
 * value: local draft while focused, commits on blur/Enter, reverts to the
 * current committed text on Escape without committing. Shared by every
 * typable field that layers free text over a structured value (the `$var`
 * path input, the icon-name input, …).
 *
 * `onCommit` receives the raw typed text on blur/Enter; it decides whether
 * and how to turn that into a domain change (parsing, no-op comparison).
 */
export default function useCommittableDraft<
  E extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(committedText: string, onCommit: (text: string) => void) {
  const [draft, setDraft] = useState(committedText);
  const [focused, setFocused] = useState(false);
  // Set by Escape (revert without committing) and by a trailing action like a
  // Clear button, whose mousedown blurs this input a moment before its own
  // click fires — without this, that blur would commit the stale draft an
  // instant before the action discards it.
  const suppressNextBlurRef = useRef(false);
  const lastCommittedRef = useRef(committedText);

  useEffect(() => {
    // A change to the committed value came from outside this input — a clear
    // button, an undo, a picker — and must win even while focused. Without
    // this, clearing strands the draft: the clear button unmounts as the value
    // empties, the browser hands focus back to this input, and the `focused`
    // gate below then blocks the sync forever. The field would go on showing a
    // value the config no longer holds, and the next blur would commit it back.
    if (committedText !== lastCommittedRef.current) {
      lastCommittedRef.current = committedText;
      setDraft(committedText);
      return;
    }
    if (!focused) setDraft(committedText);
  }, [committedText, focused]);

  function suppressNextBlur() {
    suppressNextBlurRef.current = true;
  }

  function handleKeyDown(e: KeyboardEvent<E>) {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      suppressNextBlurRef.current = true;
      setDraft(committedText);
      e.currentTarget.blur();
    }
  }

  return {
    draft,
    suppressNextBlur,
    inputProps: {
      value: draft,
      onFocus: () => setFocused(true),
      onChange: (e: ChangeEvent<E>) => setDraft(e.target.value),
      onBlur: () => {
        setFocused(false);
        if (suppressNextBlurRef.current) {
          suppressNextBlurRef.current = false;
          return;
        }
        onCommit(draft);
      },
      onKeyDown: handleKeyDown,
    },
  };
}
