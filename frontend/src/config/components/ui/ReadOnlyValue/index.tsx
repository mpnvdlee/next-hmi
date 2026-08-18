import type { ReactNode } from 'react';
import './style.css';

/**
 * A value the editor states rather than accepts — a generated id, a load
 * timestamp, a host-fixed path, a list the runtime owns.
 *
 * One affordance for all of them: no input chrome, because a box that cannot be
 * typed into reads as a broken field. `block` is for a value long enough to
 * wrap (filesystem paths), which gets a tinted box of its own instead.
 */
export default function ReadOnlyValue({
  children,
  mono,
  block,
  title,
}: {
  children: ReactNode;
  /** Identifiers and paths — anything read character by character. */
  mono?: boolean;
  /** Wrapping block rather than a single-line row value. */
  block?: boolean;
  title?: string;
}) {
  const cls = [
    'cfg-readonly-value',
    mono && 'cfg-readonly-value--mono',
    block && 'cfg-readonly-value--block',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}
