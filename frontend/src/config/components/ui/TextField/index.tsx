import useCommittableDraft from '@config/hooks/useCommittableDraft';

interface Props {
  /** Committed text. The control free-types over it. */
  value: string;
  /** Receives the raw typed text on blur/Enter — never per keystroke. It
   *  decides how (and whether) to turn that into a domain change. */
  onCommit: (text: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'password';
  step?: number | 'any';
  min?: number;
  max?: number;
  /** Renders a textarea of this many rows instead of a single-line input. */
  rows?: number;
  /** Extra classes on top of `.cfg-prop-input`. */
  className?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * The plain free-text property control: `.cfg-prop-input` over
 * `useCommittableDraft`, so every panel field shares one commit story — local
 * draft while focused, commit on blur/Enter, revert on Escape.
 *
 * Property panels used to write to the store on every keystroke, which put a
 * half-typed value into the live preview and one undo entry per character.
 */
export default function TextField({
  value,
  onCommit,
  placeholder,
  type = 'text',
  step,
  min,
  max,
  rows,
  className,
  title,
  disabled,
}: Props) {
  // The hook's handlers are typed to the element they land on, so the
  // textarea branch below spreads a textarea's own event types.
  const { inputProps } = useCommittableDraft<HTMLInputElement | HTMLTextAreaElement>(
    value,
    onCommit,
  );
  const cls = className ? `cfg-prop-input ${className}` : 'cfg-prop-input';

  if (rows !== undefined) {
    return (
      <textarea
        className={cls}
        rows={rows}
        placeholder={placeholder}
        title={title}
        disabled={disabled}
        {...inputProps}
      />
    );
  }

  return (
    <input
      className={cls}
      type={type}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      {...inputProps}
    />
  );
}
