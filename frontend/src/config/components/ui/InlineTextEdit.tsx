import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import useCommittableDraft from '@config/hooks/useCommittableDraft';

interface Props {
  value: string;
  onCommit(next: string): void;
  as?: 'div' | 'span';
  style?: CSSProperties;
  title?: string;
  emptyDisplay?: ReactNode;
  stopKeyPropagation?: boolean;
}

/** Double-click-to-rename label. The typing half is `useCommittableDraft`'s
 *  blur/Enter commit and Escape revert; this only adds the display ↔ edit
 *  swap, which ends on the same blur the hook commits (or discards) on. */
export default function InlineTextEdit({
  value,
  onCommit,
  as: Tag = 'div',
  style,
  title,
  emptyDisplay,
  stopKeyPropagation,
}: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { inputProps } = useCommittableDraft(value, (text) => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
  });

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <Tag
        className="cfg-var-inline-name"
        style={style}
        title={title}
        onDoubleClick={() => setEditing(true)}
      >
        {value || emptyDisplay || value}
      </Tag>
    );
  }

  return (
    <input
      ref={inputRef}
      className="cfg-var-inline-name-input"
      style={style}
      {...inputProps}
      onBlur={() => {
        inputProps.onBlur();
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (stopKeyPropagation) e.stopPropagation();
        inputProps.onKeyDown(e);
      }}
    />
  );
}
