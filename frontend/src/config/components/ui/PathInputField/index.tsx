import type { ReactNode } from 'react';
import { FieldActions } from '../FieldGroup';
import { ClearIcon, EditIcon } from '../actionIcons';
import useCommittableDraft from '@config/hooks/useCommittableDraft';
import './style.css';

interface ShellProps {
  children: ReactNode;
  onPick?: () => void;
  pickTitle: string;
  onClear?: () => void;
  /** Lets the typable variant swallow the blur the clear button's mousedown
   *  fires on the still-focused input, a moment before its own click. */
  onClearMouseDown?: () => void;
}

/** The `.cfg-var-field` box plus its trailing pick/clear pair — the one piece
 *  both the typable and the read-only variant share. */
function FieldShell({ children, onPick, pickTitle, onClear, onClearMouseDown }: ShellProps) {
  return (
    <div className="cfg-var-field">
      {children}
      {(onPick || onClear) && (
        <FieldActions>
          {onPick && (
            <button
              type="button"
              className="cfg-row-action-btn cfg-row-action-btn--stretch"
              title={pickTitle}
              onClick={onPick}
            >
              <EditIcon />
            </button>
          )}
          {onClear && (
            <button
              type="button"
              className="cfg-row-action-btn cfg-row-action-btn--stretch"
              title="Clear"
              onMouseDown={onClearMouseDown}
              onClick={onClear}
            >
              <ClearIcon />
            </button>
          )}
        </FieldActions>
      )}
    </div>
  );
}

interface Props {
  /** Committed text. The input free-types over it and commits on blur/Enter. */
  value: string;
  placeholder?: string;
  /** Receives the raw typed text on blur/Enter — it decides how (and whether) to
   *  turn that into a domain change. Never fires per keystroke. */
  onCommit: (text: string) => void;
  /** Opens the picker overlay behind the `✎` button. Omit to drop the button. */
  onPick?: () => void;
  pickTitle?: string;
  /** Clears the field. Omit (or pass undefined while empty) to drop the `×`. */
  onClear?: () => void;
  /** Rendered before the input, against the live draft rather than the committed
   *  value — an icon preview should follow what is being typed. */
  renderPrefix?: (draft: string) => ReactNode;
  /** Mirror the draft into the input's tooltip. An input scrolls rather than
   *  ellipsizing, so a value too long for the column otherwise hides its tail
   *  with no indication. */
  titleFromDraft?: boolean;
}

/**
 * The shared "typable value + trailing pick/clear buttons" field.
 *
 * Every field that layers free text over a structured value uses it — the `$var`
 * path input, the icon-name input, the shell's asset paths — so they all share
 * one commit story: local draft while focused, commit on blur/Enter, revert on
 * Escape, and a clear that discards the draft instead of committing it.
 *
 * `PickerField` below is the read-only sibling — same shell, no typing.
 */
export default function PathInputField({
  value,
  placeholder,
  onCommit,
  onPick,
  pickTitle = 'Change',
  onClear,
  renderPrefix,
  titleFromDraft,
}: Props) {
  const { draft, suppressNextBlur, inputProps } = useCommittableDraft(value, onCommit);

  return (
    <FieldShell
      onPick={onPick}
      pickTitle={pickTitle}
      onClear={onClear}
      onClearMouseDown={suppressNextBlur}
    >
      {renderPrefix?.(draft)}
      <input
        className={`cfg-var-field__text cfg-var-field__path-input${
          draft ? '' : ' cfg-var-field__text--empty'
        }`}
        type="text"
        placeholder={placeholder}
        title={titleFromDraft ? draft || undefined : undefined}
        {...inputProps}
      />
    </FieldShell>
  );
}

/**
 * Read-only sibling of `PathInputField`: the value is chosen entirely through
 * the picker overlay, so it renders as a span rather than an input.
 */
export function PickerField({
  displayText,
  emptyLabel = 'Not bound',
  onPick,
  pickTitle = 'Change',
  onClear,
  mono = false,
}: {
  displayText: ReactNode;
  emptyLabel?: string;
  onPick?: () => void;
  pickTitle?: string;
  onClear?: () => void;
  /** Render the value as a monospace binding path (e.g. `datasource:location`)
   *  rather than the default sans label used for icon/image/property names. */
  mono?: boolean;
}) {
  const isEmpty = displayText === '' || displayText == null;
  const base = mono ? 'cfg-var-field__path' : 'cfg-var-field__value';
  const value = isEmpty ? emptyLabel : displayText;

  return (
    <FieldShell onPick={onPick} pickTitle={pickTitle} onClear={onClear}>
      <span
        className={`cfg-var-field__text ${base}${isEmpty ? ' cfg-var-field__text--empty' : ''}`}
        title={typeof displayText === 'string' && !isEmpty ? displayText : undefined}
      >
        {/* Isolated so the RTL base direction that puts the ellipsis on the left
            (see `.cfg-var-field__path`) can't reorder the path's own punctuation. */}
        {mono ? <bdi>{value}</bdi> : value}
      </span>
    </FieldShell>
  );
}
