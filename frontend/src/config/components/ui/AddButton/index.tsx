import type { ReactNode } from 'react';
import './style.css';

interface Props {
  onClick: () => void;
  /** What gets added — every call site is a bare `+ Add`, so the tooltip
   *  carries the noun ("Add parameter", "Add variable to log"). */
  title: string;
  children?: ReactNode;
}

/**
 * The add control a list-owning section header carries. One affordance for the
 * component-property list, the historian's tracked variables and a recipe
 * type's parameters — all three used to ship their own copy of these rules.
 */
export default function AddButton({ onClick, title, children = '+ Add' }: Props) {
  return (
    <button type="button" className="cfg-add-btn" onClick={onClick} title={title}>
      {children}
    </button>
  );
}
